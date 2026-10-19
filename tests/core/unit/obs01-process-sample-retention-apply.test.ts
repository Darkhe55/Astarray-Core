/**
 * 进程样本保留**执行**的反例（2026-10-19 R54）。
 *
 * 关键纪律：**先备份再重写**、重写**原子**、**无需裁剪时不动文件**、
 * 备份/重写失败 ⇒ **文件保持原样**（不静默丢历史）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyProcessSampleRetention } from "../../../packages/core/src/orchestration/process-sample-retention-apply.js";
import { ProcessSampleStore } from "../../../packages/core/src/orchestration/process-sample-store.js";

const NOW_ISO = "2026-10-19T12:00:00.000Z";
let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-retention-apply-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sampleAt(hoursAgo: number, residentMemoryBytes: number) {
  return {
    observeEventVersion: 1 as const,
    eventType: "process" as const,
    recordedAtIso: new Date(Date.parse(NOW_ISO) - hoursAgo * 3_600_000).toISOString(),
    processIdentifier: 1,
    agentInstanceIdentifier: "agent-1",
    fields: { residentMemoryBytes },
    droppedSampleCount: 0,
  };
}

function samplesFilePath(): string {
  return path.join(baseDirectory, "perf", "process-samples.jsonl");
}

async function backupFiles(): Promise<string[]> {
  const entries = await fs.readdir(path.join(baseDirectory, "perf"));
  return entries.filter((entry) => entry.startsWith("process-samples.backup-"));
}

describe("进程样本保留执行", () => {
  it("① 无需裁剪 ⇒ 不动文件、不产生备份", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sampleAt(1, 1024));
    const before = await fs.readFile(samplesFilePath(), "utf8");

    const report = await applyProcessSampleRetention({ baseDirectory, nowIso: NOW_ISO });

    expect(report.kind).toBe("no-action");
    expect(report.backupFilePath).toBeNull();
    expect(await backupFiles()).toHaveLength(0);
    expect(await fs.readFile(samplesFilePath(), "utf8")).toBe(before);
  });

  it("② 过期样本被裁剪：**先备份**、再原子重写、保留最新", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sampleAt(48, 111));
    await store.append(sampleAt(30, 222));
    await store.append(sampleAt(1, 333));

    const report = await applyProcessSampleRetention({ baseDirectory, nowIso: NOW_ISO });

    expect(report.kind).toBe("rewritten");
    expect(report.plan.droppedByRetentionCount).toBe(2);
    expect(report.retainedSampleCount).toBe(1);
    const backups = await backupFiles();
    expect(backups).toHaveLength(1);
    // 备份内容 = 裁剪前的原文（含被淘汰的两条）
    const backupText = await fs.readFile(path.join(baseDirectory, "perf", backups[0] ?? ""), "utf8");
    expect(backupText.split("\n").filter((line) => line.trim() !== "")).toHaveLength(3);
    // 重写后只剩最新一条
    const afterText = await fs.readFile(samplesFilePath(), "utf8");
    expect(afterText).toContain("333");
    expect(afterText).not.toContain("111");
    expect(afterText).not.toContain("222");
    // 不留临时文件
    await expect(fs.access(`${samplesFilePath()}.tmp`)).rejects.toThrow();
  });

  it("③ 超预算 ⇒ 保留最新、裁剪最旧，并如实报告两类计数", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sampleAt(3, 1000));
    await store.append(sampleAt(2, 1000));
    await store.append(sampleAt(1, 1000));

    // 预算按**真实行字节数**计算：只够最后两条（先量后算，避免假设每条多大）
    const rawLines = (await fs.readFile(samplesFilePath(), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    const lineBytes = rawLines.map((line) => Buffer.byteLength(`${line}\n`, "utf8"));
    const budgetBytes = (lineBytes[1] ?? 0) + (lineBytes[2] ?? 0);

    const report = await applyProcessSampleRetention({
      baseDirectory,
      nowIso: NOW_ISO,
      budgetBytes,
    });

    expect(report.kind).toBe("rewritten");
    expect(report.plan.droppedByBudgetCount).toBe(1);
    expect(report.retainedSampleCount).toBe(2);
    const afterText = await fs.readFile(samplesFilePath(), "utf8");
    // 3 小时前那条（1000）被裁；保留 2h(1000) 与 1h(1000)
    const retainedRecords = afterText
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { recordedAtIso: string });
    expect(retainedRecords).toHaveLength(2);
    expect(retainedRecords[0]?.recordedAtIso).toBe(sampleAt(2, 1000).recordedAtIso);
    expect(retainedRecords[1]?.recordedAtIso).toBe(sampleAt(1, 1000).recordedAtIso);
  });

  it("④ 坏行不参与保留计算，但丢弃行数如实回传", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sampleAt(1, 500));
    await fs.appendFile(samplesFilePath(), "{ broken\n", "utf8");

    const report = await applyProcessSampleRetention({
      baseDirectory,
      nowIso: NOW_ISO,
      budgetBytes: 100,
    });

    expect(report.kind).toBe("rewritten");
    expect(report.discardedLineCount).toBe(1);
    const afterText = await fs.readFile(samplesFilePath(), "utf8");
    // 坏行在重写时被清掉（已计数），有效样本因超预算被裁 ⇒ 空文件
    expect(afterText.trim()).toBe("");
  });
});
