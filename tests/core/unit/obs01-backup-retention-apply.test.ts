/**
 * 备份清理执行的反例（2026-10-20 R103）。
 *
 * 核心：只删计划内、失败即停、无计划不动盘、不认识的名字不删。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyProcessSampleBackupRetention } from "../../../packages/core/src/orchestration/process-sample-backup-retention-apply.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-backup-apply-"));
  await fs.mkdir(path.join(baseDirectory, "perf"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function backupName(iso: string): string {
  return `process-samples.backup-${iso.replaceAll(":", "-")}.jsonl`;
}

async function seedBackups(isoList: ReadonlyArray<string>): Promise<void> {
  for (const iso of isoList) {
    await fs.writeFile(path.join(baseDirectory, "perf", backupName(iso)), "x", "utf8");
  }
}

describe("备份清理执行", () => {
  it("① 没有 perf 目录 ⇒ no-action（不报错）", async () => {
    await fs.rm(path.join(baseDirectory, "perf"), { recursive: true, force: true });
    const report = await applyProcessSampleBackupRetention({
      baseDirectory,
      nowIso: "2026-10-19T12:00:00.000Z",
      removeBackupFile: async () => {
        throw new Error("不应被调用");
      },
    });
    expect(report.kind).toBe("no-action");
  });

  it("② 只有计划内的备份被删（保留最新、不认识的不动）", async () => {
    await seedBackups([
      "2026-10-19T12:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    await fs.writeFile(
      path.join(baseDirectory, "perf", "process-samples.backup-manual.jsonl"),
      "x",
      "utf8",
    );
    const removedPaths: string[] = [];

    const report = await applyProcessSampleBackupRetention({
      baseDirectory,
      nowIso: "2026-10-19T12:00:00.000Z",
      maximumBackupCount: 1,
      maximumAgeHours: 1,
      removeBackupFile: async (absoluteFilePath) => {
        removedPaths.push(path.basename(absoluteFilePath));
        await fs.rm(absoluteFilePath, { force: true });
      },
    });

    expect(report.kind).toBe("pruned");
    // 最新那份必须留下
    expect(report.deletedFileNames).not.toContain(backupName("2026-10-19T12:00:00.000Z"));
    // 不认识的名字不删
    expect(removedPaths).not.toContain("process-samples.backup-manual.jsonl");
    // 删除的正好是计划内的
    expect([...removedPaths].sort()).toEqual([...report.plannedDeleteFileNames].sort());
  });

  it("③ 删除失败 ⇒ aborted 且**停止后续删除**（不假装成功）", async () => {
    await seedBackups([
      "2026-10-19T12:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    let callCount = 0;
    const report = await applyProcessSampleBackupRetention({
      baseDirectory,
      nowIso: "2026-10-19T12:00:00.000Z",
      maximumBackupCount: 1,
      maximumAgeHours: 1,
      removeBackupFile: async () => {
        callCount += 1;
        throw new Error("EBUSY");
      },
    });
    expect(report.kind).toBe("aborted");
    expect(callCount).toBe(1);
    expect(report.deletedFileNames).toHaveLength(0);
    expect(report.reason).toContain("已停止");
  });

  it("④ 没有可删的备份 ⇒ no-action 且不调用删除端口", async () => {
    await seedBackups(["2026-10-19T11:00:00.000Z"]);
    let callCount = 0;
    const report = await applyProcessSampleBackupRetention({
      baseDirectory,
      nowIso: "2026-10-19T12:00:00.000Z",
      removeBackupFile: async () => {
        callCount += 1;
      },
    });
    expect(report.kind).toBe("no-action");
    expect(callCount).toBe(0);
  });
});
