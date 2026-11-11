/**
 * CLUSTER-01 §4：派生索引持久化的边界。
 *
 * 最重要的一条反例：**未完成（partial）快照不得顶掉最后一次完整快照**——
 * 否则"扫到一半"会被当成完整结论，正是卡内禁止的"派生索引代替原文"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDiagnosticClusterSnapshot,
  computeConfigurationFingerprint,
  readLatestDiagnosticClusterSnapshot,
  resolveClusterIndexDirectory,
  saveDiagnosticClusterSnapshot,
} from "../../../packages/core/src/orchestration/diagnostic-cluster-index.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-index-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildSnapshot(options: { isComplete: boolean; byteOffset: number; generatedAtIso?: string }) {
  return buildDiagnosticClusterSnapshot({
    algorithmVersion: "diagnostic-cluster-v1",
    projectIdentifier: "project-alpha",
    generatedAtIso: options.generatedAtIso ?? "2026-11-11T00:00:00.000Z",
    cursor: { byteOffset: options.byteOffset, lineNumber: 10 },
    isComplete: options.isComplete,
    groups: [],
    configuration: { similarityThreshold: 0.85, maximumTotalEvents: 2000 },
  });
}

describe("CLUSTER-01 派生索引", () => {
  it("完整快照 ⇒ 落盘并更新 latest 指针，可读回", async () => {
    const snapshot = buildSnapshot({ isComplete: true, byteOffset: 100 });
    const saved = await saveDiagnosticClusterSnapshot({ stateDirectory, snapshot });
    expect(saved.latestFilePath).not.toBeNull();

    const readBack = await readLatestDiagnosticClusterSnapshot({
      stateDirectory,
      projectIdentifier: "project-alpha",
    });
    expect(readBack?.snapshotIdentifier).toBe(snapshot.snapshotIdentifier);
    expect(readBack?.isComplete).toBe(true);
    expect(readBack?.cursor.byteOffset).toBe(100);
  });

  it("**partial 快照不替换最后完整快照**（指针保持指向完整快照）", async () => {
    const complete = buildSnapshot({ isComplete: true, byteOffset: 100 });
    await saveDiagnosticClusterSnapshot({ stateDirectory, snapshot: complete });

    const partial = buildSnapshot({ isComplete: false, byteOffset: 250 });
    const savedPartial = await saveDiagnosticClusterSnapshot({ stateDirectory, snapshot: partial });
    /** 快照本身落盘（可追溯），但不更新指针。 */
    expect(savedPartial.latestFilePath).toBeNull();
    expect(await fs.readFile(savedPartial.snapshotFilePath, "utf8")).toContain(partial.snapshotIdentifier);

    const readBack = await readLatestDiagnosticClusterSnapshot({
      stateDirectory,
      projectIdentifier: "project-alpha",
    });
    expect(readBack?.snapshotIdentifier).toBe(complete.snapshotIdentifier);
    expect(readBack?.isComplete).toBe(true);
  });

  it("配置指纹随参数变化；同参数稳定", () => {
    const first = computeConfigurationFingerprint({ similarityThreshold: 0.85, maximumTotalEvents: 2000 });
    const second = computeConfigurationFingerprint({ maximumTotalEvents: 2000, similarityThreshold: 0.85 });
    const changed = computeConfigurationFingerprint({ similarityThreshold: 0.9, maximumTotalEvents: 2000 });
    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });

  it("索引目录落在状态目录的 analysis 下，且项目 ID 不能穿越路径", () => {
    const directory = resolveClusterIndexDirectory(stateDirectory, "../../etc/passwd");
    expect(directory.startsWith(path.join(stateDirectory, "analysis", "diagnostic-clusters"))).toBe(true);
    expect(directory.includes("..")).toBe(false);
  });

  it("快照损坏或 schema 版本不符 ⇒ 读回 null（不得当成空结果）", async () => {
    const directory = resolveClusterIndexDirectory(stateDirectory, "project-alpha");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "latest.json"),
      JSON.stringify({ snapshotIdentifier: "broken" }),
      "utf8",
    );
    expect(
      await readLatestDiagnosticClusterSnapshot({ stateDirectory, projectIdentifier: "project-alpha" }),
    ).toBeNull();
  });
});
