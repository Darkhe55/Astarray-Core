/**
 * `obs perf rotate` 的反例（2026-10-19 R76）。
 *
 * 关键：**dry-run 绝不改盘**（连备份都不写）；`--apply` 才执行且**先备份**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProcessSampleStore } from "../../../packages/core/src/orchestration/process-sample-store.js";
import {
  executeObsPerfRotateCommand,
  readProcessSamplesFileText,
} from "../../../packages/tui/src/cli/obs-perf-rotate-command.js";

let stateDirectory: string;
let stdoutText: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-obs-rotate-"));
  stdoutText = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  void originalWrite;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function seedExpiredSample(): Promise<void> {
  const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
  await store.append({
    observeEventVersion: 1,
    eventType: "process",
    recordedAtIso: "2026-10-17T00:00:00.000Z",
    processIdentifier: 1,
    agentInstanceIdentifier: "agent-1",
    fields: { residentMemoryBytes: 1234 },
    droppedSampleCount: 0,
  });
}

describe("obs perf rotate", () => {
  it("① 默认 dry-run：报告计划但**不改盘、不产生备份**", async () => {
    await seedExpiredSample();
    const beforeText = await readProcessSamplesFileText(stateDirectory);

    const exitCode = await executeObsPerfRotateCommand({
      stateDirectory,
      isJsonOutput: true,
      nowIso: "2026-10-19T00:00:00.000Z",
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as { kind: string; isApply: boolean; plan: { kind: string } };
    expect(payload.kind).toBe("preview");
    expect(payload.isApply).toBe(false);
    // 过期样本确实在计划里
    expect(payload.plan.kind).toBe("trim-required");
    // **文件一字未改**
    expect(await readProcessSamplesFileText(stateDirectory)).toBe(beforeText);
    const perfEntries = await fs.readdir(path.join(stateDirectory, "perf"));
    expect(perfEntries.filter((entry) => entry.startsWith("process-samples.backup-"))).toHaveLength(0);
  });

  it("② --apply：真正裁剪并**先备份**", async () => {
    await seedExpiredSample();

    const exitCode = await executeObsPerfRotateCommand({
      stateDirectory,
      isApply: true,
      isJsonOutput: true,
      nowIso: "2026-10-19T00:00:00.000Z",
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      isApply: boolean;
      applyKind: string;
      backupFilePath: string | null;
    };
    expect(payload.kind).toBe("applied");
    expect(payload.isApply).toBe(true);
    expect(payload.applyKind).toBe("rewritten");
    expect(payload.backupFilePath).not.toBeNull();
    // 过期样本被裁掉
    expect((await readProcessSamplesFileText(stateDirectory))?.trim()).toBe("");
  });

  it("③ 非法预算/保留时长 ⇒ 直接拒绝，且**不改盘**（NaN 预算曾会裁掉全部样本）", async () => {
    await seedExpiredSample();
    const beforeText = await readProcessSamplesFileText(stateDirectory);

    for (const invalidInput of [
      { budgetBytes: Number.NaN },
      { budgetBytes: -1 },
      { retentionHours: Number.NaN },
      { retentionHours: 0 },
    ]) {
      stdoutText = "";
      const exitCode = await executeObsPerfRotateCommand({
        stateDirectory,
        isApply: true,
        isJsonOutput: true,
        nowIso: "2026-10-19T00:00:00.000Z",
        ...invalidInput,
      });
      expect(exitCode).toBe(1);
      // 报错走 stderr，且**文件一字未改**
      expect(await readProcessSamplesFileText(stateDirectory)).toBe(beforeText);
    }
    const perfEntries = await fs.readdir(path.join(stateDirectory, "perf"));
    expect(perfEntries.filter((entry) => entry.startsWith("process-samples.backup-"))).toHaveLength(0);
  });
});
