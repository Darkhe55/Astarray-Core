/**
 * R108 的反例：`obs perf-rotate --prune-backups` 只删**计划内**备份，默认不清理。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProcessSampleStore } from "../../../packages/core/src/orchestration/process-sample-store.js";
import { executeObsPerfRotateCommand } from "../../../packages/tui/src/cli/obs-perf-rotate-command.js";

let stateDirectory: string;
let stdoutText: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-prune-"));
  stdoutText = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function backupName(iso: string): string {
  return `process-samples.backup-${iso.replaceAll(":", "-")}.jsonl`;
}

async function seedPerfDirectoryWithBackups(): Promise<void> {
  const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
  await store.append({
    observeEventVersion: 1,
    eventType: "process",
    recordedAtIso: "2026-10-19T11:00:00.000Z",
    processIdentifier: 1,
    agentInstanceIdentifier: "agent-1",
    fields: { residentMemoryBytes: 1024 },
    droppedSampleCount: 0,
  });
  const perfDirectory = path.join(stateDirectory, "perf");
  await fs.mkdir(perfDirectory, { recursive: true });
  for (const iso of [
    "2026-09-01T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z",
    "2026-09-03T00:00:00.000Z",
  ]) {
    await fs.writeFile(path.join(perfDirectory, backupName(iso)), "backup\n", "utf8");
  }
  // 手工备份：不属于计划内，任何情况下都不得删除
  await fs.writeFile(path.join(perfDirectory, "process-samples.backup-manual.jsonl"), "manual\n", "utf8");
}

async function listBackupNames(): Promise<string[]> {
  const entries = await fs.readdir(path.join(stateDirectory, "perf"));
  return entries.filter((entry) => entry.startsWith("process-samples.backup-"));
}

describe("obs perf-rotate --prune-backups", () => {
  it("① 默认不清理：不加开关时备份一个都不动", async () => {
    await seedPerfDirectoryWithBackups();
    const before = await listBackupNames();
    const exitCode = await executeObsPerfRotateCommand({
      stateDirectory,
      isApply: true,
      isJsonOutput: true,
      nowIso: "2026-10-19T12:00:00.000Z",
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as { backupPrune: unknown };
    expect(payload.backupPrune).toBeNull();
    expect(await listBackupNames()).toEqual(before);
  });

  it("② --prune-backups：删计划内的旧备份，保留手工备份与最新一份", async () => {
    await seedPerfDirectoryWithBackups();
    const exitCode = await executeObsPerfRotateCommand({
      stateDirectory,
      isApply: true,
      isJsonOutput: true,
      nowIso: "2026-10-19T12:00:00.000Z",
      isPruneBackups: true,
      maximumBackupCount: 1,
      maximumBackupAgeHours: 1,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      backupPrune: { kind: string; deletedFileCount: number } | null;
    };
    expect(payload.backupPrune?.kind).toBe("pruned");
    expect(payload.backupPrune?.deletedFileCount).toBeGreaterThan(0);

    const remaining = await listBackupNames();
    // 手工备份必须还在
    expect(remaining).toContain("process-samples.backup-manual.jsonl");
    // 三份旧备份不应全在
    expect(remaining.length).toBeLessThan(4);
  });

  it("③ 无备份可删 ⇒ no-action（不报错，也不删除任何东西）", async () => {
    const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-10-19T11:00:00.000Z",
      processIdentifier: 1,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 1024 },
      droppedSampleCount: 0,
    });
    const exitCode = await executeObsPerfRotateCommand({
      stateDirectory,
      isApply: true,
      isJsonOutput: true,
      nowIso: "2026-10-19T12:00:00.000Z",
      isPruneBackups: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as { backupPrune: { kind: string } | null };
    expect(payload.backupPrune?.kind).toBe("no-action");
  });
});

