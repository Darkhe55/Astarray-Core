/**
 * CLUSTER-01 §5：用户纠正记录的边界。
 *
 * 三个必证反例：
 * 1. 写意见**不改动快照文件**（不得自动重分组 / 改原始事件）；
 * 2. 来源身份必须保存且不可为空；
 * 3. 互相矛盾的意见必须显式标冲突，且**意见不是事实**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendDiagnosticClusterFeedback,
  readDiagnosticClusterFeedback,
} from "../../../packages/core/src/orchestration/diagnostic-cluster-feedback.js";
import {
  buildDiagnosticClusterSnapshot,
  resolveClusterIndexDirectory,
  saveDiagnosticClusterSnapshot,
} from "../../../packages/core/src/orchestration/diagnostic-cluster-index.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-feedback-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function seedSnapshot() {
  const snapshot = buildDiagnosticClusterSnapshot({
    algorithmVersion: "diagnostic-cluster-v1",
    projectIdentifier: "project-alpha",
    generatedAtIso: "2026-11-11T00:00:00.000Z",
    cursor: { byteOffset: 0, lineNumber: 0 },
    isComplete: true,
    groups: [],
    configuration: { similarityThreshold: 0.85 },
  });
  const saved = await saveDiagnosticClusterSnapshot({ stateDirectory, snapshot });
  return saved.snapshotFilePath;
}

describe("CLUSTER-01 纠正记录", () => {
  it("写意见**不改动快照文件**（字节不变）", async () => {
    const snapshotPath = await seedSnapshot();
    const before = await fs.readFile(snapshotPath, "utf8");
    await appendDiagnosticClusterFeedback({
      stateDirectory,
      projectIdentifier: "project-alpha",
      groupIdentifier: "group-1",
      verdict: "agree",
      sourceIdentity: "user-1",
      sourceKind: "user",
      recordedAtIso: "2026-11-11T01:00:00.000Z",
      noteText: "这条看起来是同一个问题",
    });
    const after = await fs.readFile(snapshotPath, "utf8");
    expect(after).toBe(before);
  });

  it("空来源身份 ⇒ 拒绝（必须能追溯提出者）", async () => {
    await expect(
      appendDiagnosticClusterFeedback({
        stateDirectory,
        projectIdentifier: "project-alpha",
        groupIdentifier: "group-1",
        verdict: "note",
        sourceIdentity: "   ",
        sourceKind: "agent",
        recordedAtIso: "2026-11-11T01:00:00.000Z",
        noteText: "x",
      }),
    ).rejects.toThrow(/source-identity/u);
  });

  it("来源身份被保存；矛盾意见标冲突；意见不是事实", async () => {
    const base = {
      stateDirectory,
      projectIdentifier: "project-alpha",
      groupIdentifier: "group-1",
    };
    await appendDiagnosticClusterFeedback({
      ...base,
      verdict: "agree",
      sourceIdentity: "user-1",
      sourceKind: "user",
      recordedAtIso: "2026-11-11T01:00:00.000Z",
      noteText: "同意",
    });
    await appendDiagnosticClusterFeedback({
      ...base,
      verdict: "disagree",
      sourceIdentity: "worker:mission-1:T-001",
      sourceKind: "agent",
      recordedAtIso: "2026-11-11T02:00:00.000Z",
      noteText: "不同意",
    });
    const summary = await readDiagnosticClusterFeedback(base);
    expect(summary.records).toHaveLength(2);
    expect(summary.records.map((record) => record.sourceIdentity)).toEqual([
      "user-1",
      "worker:mission-1:T-001",
    ]);
    expect(summary.hasConflict).toBe(true);
    expect(summary.isFact).toBe(false);
    expect(summary.records.every((record) => record.isFact === false)).toBe(true);
  });

  it("没有意见 ⇒ 空结果且不报错；敏感文本被脱敏", async () => {
    const empty = await readDiagnosticClusterFeedback({
      stateDirectory,
      projectIdentifier: "project-alpha",
      groupIdentifier: "group-none",
    });
    expect(empty.records).toEqual([]);
    expect(empty.hasConflict).toBe(false);

    await appendDiagnosticClusterFeedback({
      stateDirectory,
      projectIdentifier: "project-alpha",
      groupIdentifier: "group-1",
      verdict: "note",
      sourceIdentity: "user-1",
      sourceKind: "user",
      recordedAtIso: "2026-11-11T03:00:00.000Z",
      noteText: "密钥 sk-abcdefghijklmnopqrstuvwxyz 泄露了吗",
    });
    const filePath = path.join(
      resolveClusterIndexDirectory(stateDirectory, "project-alpha"),
      "feedback.jsonl",
    );
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});
