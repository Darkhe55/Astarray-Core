/**
 * COORD-01-03 §3：**产物证明门禁在消费路径生效**。
 *
 * 反例优先：
 * - 完成消息要求产物证明但**无引用** ⇒ 不应用，记 blocked 且原因指向 `artifact-not-provided`；
 * - 引用**陈旧** ⇒ 不应用；
 * - 引用合格 ⇒ 正常应用；
 * - 不要求产物证明的普通消息 ⇒ 不受影响。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationMessageConsumer } from "../../../packages/core/src/orchestration/coordination-message-consumer.js";
import {
  CoordinationPartitionLeaseStore,
  buildCoordinationPartitionKey,
} from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";

let stateDirectory: string;
let partitionKey: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-gate-"));
  partitionKey = buildCoordinationPartitionKey({
    projectIdentifier: "project-alpha",
    schedulerAgentInstanceIdentifier: "scheduler-1",
  });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const currentRevisions: Record<string, number> = { "src/a.ts": 3 };

function buildHarness(isMessageArtifactRequired = true) {
  const journal = new MailboxJournal(path.join(stateDirectory, "journal"));
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
  });
  const stateStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(stateDirectory, "state"),
    leaseStore,
  });
  const consumer = new CoordinationMessageConsumer({
    journal,
    leaseStore,
    stateStore,
    artifactGate: {
      isArtifactProofRequired: () => isMessageArtifactRequired,
      resolveCurrentRevision: async (artifactIdentifier) =>
        currentRevisions[artifactIdentifier] ?? null,
    },
  });
  return { journal, consumer, stateStore };
}

async function enqueueCompletion(
  journal: MailboxJournal,
  messageId: string,
  artifactReferences?: ReadonlyArray<{ artifactIdentifier: string; revision: number }>,
) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId: "scheduler:mission-1",
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: messageId,
    payload: {
      kind: "collaboration-request",
      messageIdentifier: messageId,
      correlationIdentifier: messageId,
      taskIdentifier: "T-001",
      summary: "完成",
      authorizationEpoch: 0,
      hopCount: 0,
      ...(artifactReferences === undefined ? {} : { artifactReferences }),
    },
  } as never);
}

const stepInput = () => ({
  partitionKey,
  recipientId: "scheduler:mission-1",
  ownerInstanceIdentifier: "consumer-a",
  leaseTtlMilliseconds: 60_000,
  toSnapshot: (message: { messageId: string }) => ({ appliedMessage: message.messageId }),
});

describe("产物证明门禁", () => {
  it("① 要求产物但无引用 ⇒ 不应用且记 blocked（artifact-not-provided）", async () => {
    const { journal, consumer, stateStore } = buildHarness(true);
    await enqueueCompletion(journal, "message-1");
    const result = await consumer.runConsumptionStep(stepInput());
    expect(result.appliedMessageCount).toBe(0);
    expect(result.blockedMessageCount).toBe(1);
    const state = await stateStore.readState(partitionKey);
    expect(state?.appliedMessages).toHaveLength(0);
    const [view] = await journal.readMessageStatusView({
      recipientId: "scheduler:mission-1",
      messageId: "message-1",
    });
    expect(view?.applicationState.state).toBe("blocked");
    expect(view?.applicationState.reason).toContain("artifact-not-provided");
  });

  it("② 引用陈旧 ⇒ 不应用且原因含 artifact-not-current", async () => {
    const { journal, consumer } = buildHarness(true);
    await enqueueCompletion(journal, "message-2", [{ artifactIdentifier: "src/a.ts", revision: 1 }]);
    const result = await consumer.runConsumptionStep(stepInput());
    expect(result.appliedMessageCount).toBe(0);
    const [view] = await journal.readMessageStatusView({
      recipientId: "scheduler:mission-1",
      messageId: "message-2",
    });
    expect(view?.applicationState.reason).toContain("artifact-not-current");
  });

  it("③ 引用合格 ⇒ 正常应用", async () => {
    const { journal, consumer } = buildHarness(true);
    await enqueueCompletion(journal, "message-3", [{ artifactIdentifier: "src/a.ts", revision: 3 }]);
    const result = await consumer.runConsumptionStep(stepInput());
    expect(result.appliedMessageCount).toBe(1);
  });

  it("④ 不要求产物证明的普通消息 ⇒ 不受影响", async () => {
    const { journal, consumer } = buildHarness(false);
    await enqueueCompletion(journal, "message-4");
    const result = await consumer.runConsumptionStep(stepInput());
    expect(result.appliedMessageCount).toBe(1);
  });
});
