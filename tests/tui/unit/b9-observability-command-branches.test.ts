/**
 * B9（2026-11-25）：可观测性命令（obs perf/diag/process/export）的只读与拒绝分支。
 *
 * 纪律："没有样本" ≠ "用量为零"；观测故障降级不阻塞；导出被拒时**不写任何文件**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeObsDiagCommand,
  executeObsDiagExportCommand,
  executeObsPerfCommand,
  executeObsProcessCommand,
} from "../../../packages/tui/src/cli/observability-command.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-obs-"));
  captured = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const text = (): string => captured.join("");

describe("B9：可观测性命令", () => {
  it("① obs perf：无样本 JSON ⇒ hasSamples=false 且给出说明；文本同样可读", async () => {
    expect(
      await executeObsPerfCommand({ stateDirectory, isJsonOutput: true } as never),
    ).toBe(0);
    const parsed = JSON.parse(text()) as { kind: string; hasSamples: boolean; notice: string | null };
    expect(parsed.kind).toBe("ok");
    expect(parsed.hasSamples).toBe(false);
    expect(parsed.notice).toBeTruthy();

    captured.length = 0;
    expect(
      await executeObsPerfCommand({ stateDirectory, isJsonOutput: false } as never),
    ).toBe(0);
    expect(text()).toContain("性能样本");
  });

  it("② obs diag：无数据 JSON/文本都返回结构化摘要（不伪造故障）", async () => {
    expect(
      await executeObsDiagCommand({ stateDirectory, isJsonOutput: true } as never),
    ).toBe(0);
    expect(typeof JSON.parse(text())).toBe("object");

    captured.length = 0;
    expect(
      await executeObsDiagCommand({ stateDirectory, isJsonOutput: false } as never),
    ).toBe(0);
    expect(text().length).toBeGreaterThan(0);
  });

  it("③ obs process：无样本 JSON/文本；--summary 时返回聚合而不返回逐条样本", async () => {
    expect(
      await executeObsProcessCommand({ stateDirectory, isJsonOutput: true } as never),
    ).toBe(0);
    const parsed = JSON.parse(text()) as { hasSamples: boolean; samples: unknown[] };
    expect(parsed.hasSamples).toBe(false);
    expect(parsed.samples).toEqual([]);

    captured.length = 0;
    expect(
      await executeObsProcessCommand({
        stateDirectory,
        isJsonOutput: true,
        summarize: true,
      } as never),
    ).toBe(0);
    const summarized = JSON.parse(text()) as { aggregate: unknown; samples: unknown[] };
    expect(summarized.samples).toEqual([]);

    captured.length = 0;
    expect(
      await executeObsProcessCommand({ stateDirectory, isJsonOutput: false } as never),
    ).toBe(0);
    expect(text()).toContain("进程样本");
  });

  it("④ obs diag export：窗口非法 ⇒ 拒绝且不写文件", async () => {
    const outputFilePath = path.join(stateDirectory, "evidence-pack.json");
    const exitCode = await executeObsDiagExportCommand({
      stateDirectory,
      outputFilePath,
      windowStartIso: "2026-12-31T00:00:00.000Z",
      windowEndIso: "2026-01-01T00:00:00.000Z",
      sections: ["perf"],
      astarrayVersion: "0.1.0",
      platform: process.platform,
      redactionSummary: "已脱敏",
      isUserInitiated: true,
      generatedAtIso: "2026-11-25T00:00:00.000Z",
      isJsonOutput: true,
    } as never);
    expect(exitCode).not.toBe(0);
    await expect(fs.stat(outputFilePath)).rejects.toThrow();
  });
});
