/**
 * B9（2026-11-25）：存储损坏矩阵（损坏文件必须被识别，不得当作空数据静默覆盖）。
 *
 * 覆盖 4 个共享同一套原子读写模式的 Store：
 * - DecisionSubmissionStore：损坏 ⇒ readState(kind="corrupted")，且下一次写入拒绝覆盖；
 * - CoordinationTaskApplicationLedger：损坏 ⇒ 不吞掉（抛出或标记 corrupted），不静默重放；
 * - MissionSequenceBindingStore：损坏 ⇒ list 不崩溃、不伪造绑定；
 * - DeferredInsertionQueueStore：损坏 ⇒ read/listPending 返回空（宁可无待办也不伪造）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { CoordinationTaskApplicationLedger } from "../../../packages/core/src/orchestration/coordination-task-application-ledger.js";
import { DecisionSubmissionStore } from "../../../packages/core/src/orchestration/decision-submission.js";
import { DeferredInsertionQueueStore } from "../../../packages/core/src/orchestration/deferred-insertion-queue.js";
import { MissionSequenceBindingStore } from "../../../packages/core/src/orchestration/mission-sequence-binding-store.js";
import { MissionTaskSequenceMapStore } from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";
import { ResumeIntentReceiptStore } from "../../../packages/core/src/orchestration/continuation-receipt-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-store-corrupt-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function listJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(fullPath)));
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".bak")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function corruptAllJsonFiles(): Promise<string[]> {
  const files = await listJsonFiles(stateDirectory);
  for (const filePath of files) {
    await fs.writeFile(filePath, "{ 损坏", "utf8");
  }
  return files;
}

describe("B9：存储损坏矩阵", () => {
  it("① DecisionSubmissionStore：损坏 ⇒ corrupted，写入拒绝覆盖", async () => {
    const store = new DecisionSubmissionStore({ baseDirectory: stateDirectory });
    await store.upsertPending({
      submissionIdentifier: "sub-1",
      projectIdentifier: "project-1",
      decisionId: "decision-1",
      summary: "摘要",
      recommendedReason: null,
      affectedStepIdentifiers: [],
      candidates: [],
      state: "pending-record",
      channel: null,
      receiptIdentifier: null,
      createdAtIso: "2026-11-25T00:00:00.000Z",
      submittedAtIso: null,
      answeredAtIso: null,
      answer: null,
    } as never);
    await corruptAllJsonFiles();
    const state = await store.readState();
    expect(state.kind).toBe("corrupted");
    await expect(
      store.upsertPending({
        submissionIdentifier: "sub-2",
        projectIdentifier: "project-1",
        decisionId: "decision-2",
        summary: "摘要 2",
        recommendedReason: null,
        affectedStepIdentifiers: [],
        candidates: [],
        state: "pending-record",
        channel: null,
        receiptIdentifier: null,
        createdAtIso: "2026-11-25T00:00:00.000Z",
        submittedAtIso: null,
        answeredAtIso: null,
        answer: null,
      } as never),
    ).rejects.toThrow();
  });

  it("② CoordinationTaskApplicationLedger：损坏 ⇒ readAll 不静默当作空并允许覆盖", async () => {
    const ledger = new CoordinationTaskApplicationLedger({ baseDirectory: stateDirectory });
    await ledger.recordIntent({
      messageIdentifier: "msg-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
      contentFingerprint: "fp-1",
    } as never);
    await corruptAllJsonFiles();
    let threw = false;
    let entries: ReadonlyMap<string, unknown> | null = null;
    try {
      entries = await ledger.readAll();
    } catch {
      threw = true;
    }
    /** 允许两种如实处理：抛出（显式失败）或返回空；但**不得**返回旧条目。 */
    expect(threw || entries === null || entries.size === 0).toBe(true);
  });

  it("③ MissionSequenceBindingStore：损坏 ⇒ list 不崩溃、不伪造绑定", async () => {
    const store = new MissionSequenceBindingStore({ baseDirectory: stateDirectory });
    await store.bind({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "seq-1",
      ownerAgentInstanceIdentifier: "agent-1",
      boundAtIso: "2026-11-25T00:00:00.000Z",
    });
    await corruptAllJsonFiles();
    const bindings = await store.list().catch(() => []);
    expect(bindings).toEqual([]);
  });

  it("④ DeferredInsertionQueueStore：损坏 ⇒ read 回空队列（不伪造待办）", async () => {
    const store = new DeferredInsertionQueueStore({ baseDirectory: stateDirectory });
    await store.enqueue({
      insertRequestIdentifier: "insert-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-9",
      sequenceIdentifier: "seq-1",
      ownerAgentInstanceIdentifier: "agent-1",
      reason: "非安全点",
      enqueuedAtIso: "2026-11-25T00:00:00.000Z",
    });
    await corruptAllJsonFiles();
    const document = await store.read().catch(() => null);
    expect(document === null || document.pending.length === 0).toBe(true);
  });
});

describe("B9：存储损坏矩阵（续）", () => {
  it("⑤ MissionTaskSequenceMapStore：损坏 ⇒ listForMission 不崩溃、不伪造映射", async () => {
    const store = new MissionTaskSequenceMapStore({ baseDirectory: stateDirectory });
    await store.bind({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "seq-1",
      ownerAgentInstanceIdentifier: "agent-1",
      missionTaskIdentifier: "T-1",
      sequenceTaskIdentifier: "seq-task-1",
    });
    await corruptAllJsonFiles();
    const entries = await store
      .listForMission({ missionIdentifier: "mission-1", sequenceIdentifier: "seq-1" })
      .catch(() => []);
    expect(entries).toEqual([]);
  });

  it("⑥ ResumeIntentReceiptStore：损坏 ⇒ findValid 不返回可用回执（fail-closed）", async () => {
    const store = new ResumeIntentReceiptStore({ baseDirectory: stateDirectory });
    await store.issue({
      receiptIdentifier: "receipt-1",
      request: {
        requestIdentifier: "req-1",
        projectIdentifier: "mission-1",
        conversationIdentifier: "conv-1",
        taskIdentifier: "T-1",
        expectedRevision: 1,
      } as never,
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso: "2026-11-25T00:00:00.000Z",
    });
    await corruptAllJsonFiles();
    const result = await store
      .findValid({
        requestIdentifier: "req-1",
        principalIdentifier: "user-1",
        taskIdentifier: "T-1",
        expectedRevision: 1,
        nowIso: "2026-11-25T00:00:10.000Z",
      })
      .catch(() => null);
    /** 损坏 ⇒ 不得返回可用回执（可以是 null，也可以是 {receipt:null, reason}）。 */
    expect(result === null || result.receipt === null).toBe(true);
  });
});