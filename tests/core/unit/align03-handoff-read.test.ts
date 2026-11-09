/**
 * ALIGN-03-07（2026-11-09）：**移交文件的读入与校验**。
 *
 * 缺口：`agent-handoffs/` 只写不读 ⇒ 三级关闭后档案无人接手。
 * 本文件钉住"能读回"与"读回时必须校验"两件事。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readLatestTertiaryHandoff } from "../../../packages/core/src/orchestration/tertiary-handoff-store.js";

vi.setConfig({ testTimeout: 30_000 });

let handoffDirectoryPath: string;

beforeEach(async () => {
  handoffDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-handoff-"));
});

afterEach(async () => {
  await fs.rm(handoffDirectoryPath, { recursive: true, force: true, maxRetries: 10 });
});

async function writeHandoff(input: {
  readonly fileName: string;
  readonly document: Record<string, unknown>;
}): Promise<void> {
  await fs.writeFile(
    path.join(handoffDirectoryPath, input.fileName),
    JSON.stringify(input.document),
    "utf8",
  );
}

function buildValidDocument(agentInstanceId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agentInstanceId,
    createdAtIso: "2026-11-09T00:00:00.000Z",
    memoryArchiveRevision: 3,
    selectedAttachmentHashes: ["abc"],
    doesMergeSiblingMemory: false,
    note: "只含本个体",
  };
}

describe("ALIGN-03-07 移交文件读入", () => {
  it("目录不存在 ⇒ absent（不伪造一份）", async () => {
    const outcome = await readLatestTertiaryHandoff({
      handoffDirectoryPath: path.join(handoffDirectoryPath, "missing"),
      agentInstanceId: "worker:task-1",
    });
    expect(outcome.kind).toBe("absent");
  }, 30_000);

  it("合法移交 ⇒ found，且带回文件名与档案 revision", async () => {
    await writeHandoff({
      fileName: "worker_task-1-1700000000000.json",
      document: buildValidDocument("worker:task-1"),
    });
    const outcome = await readLatestTertiaryHandoff({
      handoffDirectoryPath,
      agentInstanceId: "worker:task-1",
    });
    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.document.memoryArchiveRevision).toBe(3);
    expect(outcome.document.handoffFileName).toBe("worker_task-1-1700000000000.json");
  }, 30_000);

  it("多个移交 ⇒ 取**最新**（按文件名时间戳，不按 mtime）", async () => {
    await writeHandoff({
      fileName: "worker_task-1-1700000000000.json",
      document: buildValidDocument("worker:task-1"),
    });
    await writeHandoff({
      fileName: "worker_task-1-1700000009999.json",
      document: { ...buildValidDocument("worker:task-1"), memoryArchiveRevision: 9 },
    });
    const outcome = await readLatestTertiaryHandoff({
      handoffDirectoryPath,
      agentInstanceId: "worker:task-1",
    });
    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.document.memoryArchiveRevision).toBe(9);
  }, 30_000);

  it("个体不一致 ⇒ invalid（防串档）", async () => {
    await writeHandoff({
      fileName: "worker_task-1-1700000000000.json",
      document: buildValidDocument("worker:task-2"),
    });
    const outcome = await readLatestTertiaryHandoff({
      handoffDirectoryPath,
      agentInstanceId: "worker:task-1",
    });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.detail).toContain("不一致");
  }, 30_000);

  it("声明合并兄弟记忆 ⇒ 拒绝接手", async () => {
    await writeHandoff({
      fileName: "worker_task-1-1700000000000.json",
      document: { ...buildValidDocument("worker:task-1"), doesMergeSiblingMemory: true },
    });
    const outcome = await readLatestTertiaryHandoff({
      handoffDirectoryPath,
      agentInstanceId: "worker:task-1",
    });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.detail).toContain("兄弟记忆");
  }, 30_000);

  it("损坏文件 ⇒ invalid（不静默当空）", async () => {
    await fs.writeFile(
      path.join(handoffDirectoryPath, "worker_task-1-1700000000000.json"),
      "{ not json",
      "utf8",
    );
    const outcome = await readLatestTertiaryHandoff({
      handoffDirectoryPath,
      agentInstanceId: "worker:task-1",
    });
    expect(outcome.kind).toBe("invalid");
  }, 30_000);
});
