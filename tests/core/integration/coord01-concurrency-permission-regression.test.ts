/**
 * COORD-01-04（卡 §7）：**并发 + 权限回归**。
 *
 * 并发：用两个独立的 store 实例模拟**两个进程**访问同一目录 —— 只有当前所有者能提交；
 * 旧 fencing token 的迟提交必须被拒（若两条都成功，本用例必须红）。
 *
 * 权限回归（集中守护，防止后续改动悄悄放宽）：
 * - 控制旁路拒绝 agent 来源；
 * - 产物门禁在**无版本解析器**时 fail-closed（不得放行）；
 * - 上下文准入不把信息类消息注入模型上下文。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { ContextAdmissionController } from "../../../packages/core/src/orchestration/context-admission.js";
import { ControlBypassController } from "../../../packages/core/src/orchestration/control-bypass.js";
import { CoordinationMessageConsumer } from "../../../packages/core/src/orchestration/coordination-message-consumer.js";
import {
  CoordinationPartitionLeaseStore,
  buildCoordinationPartitionKey,
} from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";

let stateDirectory: string;
let partitionKey: string;
let nowUnixMilliseconds: number;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-concurrency-"));
  partitionKey = buildCoordinationPartitionKey({
    projectIdentifier: "project-alpha",
    schedulerAgentInstanceIdentifier: "scheduler-1",
  });
  nowUnixMilliseconds = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

/** 每个调用相当于**独立进程**（各自实例、共享目录）。 */
function buildProcess(ownerInstanceIdentifier: string) {
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  const stateStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(stateDirectory, "state"),
    leaseStore,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  return { ownerInstanceIdentifier, leaseStore, stateStore };
}

describe("并发：只有当前所有者能提交", () => {
  it("① 两个进程竞争 ⇒ 后到者拿不到租约", async () => {
    const first = buildProcess("process-a");
    const second = buildProcess("process-b");
    await first.stateStore.ensurePartitionState({ partitionKey });
    const leaseA = (await first.leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "process-a",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };
    expect(leaseA.fencingToken).toBe(1);

    const leaseB = await second.leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "process-b",
      ttlMilliseconds: 60_000,
    });
    expect(leaseB.outcome).toBe("held-by-other");
  });

  it("② 旧 token 迟提交 ⇒ not-owner（若两条都成功，此处必红）", async () => {
    const first = buildProcess("process-a");
    const second = buildProcess("process-b");
    await first.stateStore.ensurePartitionState({ partitionKey });
    const leaseA = (await first.leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "process-a",
      ttlMilliseconds: 1000,
    })) as { fencingToken: number };

    nowUnixMilliseconds += 2000;
    const leaseB = (await second.leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "process-b",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };
    expect(leaseB.fencingToken).toBe(2);

    const appliedByB = await second.stateStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "process-b",
      fencingToken: leaseB.fencingToken,
      messageIdentifier: "message-b",
      expectedStateVersion: 0,
      nextSnapshot: { by: "process-b" },
    });
    expect(appliedByB.outcome).toBe("applied");

    const lateByA = await first.stateStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "process-a",
      fencingToken: leaseA.fencingToken,
      messageIdentifier: "message-a",
      expectedStateVersion: 0,
      nextSnapshot: { by: "process-a" },
    });
    expect(lateByA).toEqual({ outcome: "not-owner" });
  });
});

describe("权限回归", () => {
  it("③ 控制旁路：agent 来源不得自授控制权", () => {
    const controlBypass = new ControlBypassController();
    const result = controlBypass.applyControlEvent({
      event: {
        eventIdentifier: "control-agent",
        kind: "emergency-stop",
        source: { sourceKind: "agent", sourceIdentifier: "worker-1" },
        targetMissionIdentifier: "mission-1",
        issuedAtIso: "2026-11-11T00:00:00.000Z",
      },
    });
    expect(result.outcome).toBe("rejected-untrusted-source");
    expect(controlBypass.isExecutionBlocked("mission-1")).toBe(false);
  });

  it("④ 产物门禁：无版本解析器时 fail-closed，不放行", async () => {
    const journal = new MailboxJournal(path.join(stateDirectory, "journal"));
    const leaseStore = new CoordinationPartitionLeaseStore({
      stateDirectory: path.join(stateDirectory, "leases"),
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    const stateStore = new CoordinationStateTransactionStore({
      stateDirectory: path.join(stateDirectory, "state"),
      leaseStore,
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    const consumer = new CoordinationMessageConsumer({
      journal,
      leaseStore,
      stateStore,
      artifactGate: {
        isArtifactProofRequired: () => true,
        /** 宿主未配置解析器 ⇒ 一律解析不到 ⇒ 必须拒绝。 */
        resolveCurrentRevision: async () => null,
      },
    });
    await journal.enqueue({
      protocolVersion: 1,
      messageId: "message-proof",
      source: { sourceType: "agent", agentInstanceId: "worker-1" },
      recipientId: "scheduler:mission-1",
      priority: "state",
      createdAtIso: "2026-11-11T00:00:00.000Z",
      idempotencyKey: "message-proof",
      payload: {
        kind: "collaboration-request",
        messageIdentifier: "message-proof",
        correlationIdentifier: "message-proof",
        taskIdentifier: "T-001",
        summary: "完成",
        authorizationEpoch: 0,
        hopCount: 0,
        artifactReferences: [{ artifactIdentifier: "src/a.ts", revision: 1 }],
      },
    } as never);

    const result = await consumer.runConsumptionStep({
      partitionKey,
      recipientId: "scheduler:mission-1",
      ownerInstanceIdentifier: "process-a",
      leaseTtlMilliseconds: 60_000,
      toSnapshot: (message) => ({ appliedMessage: message.messageId }),
    });
    expect(result.appliedMessageCount).toBe(0);
    expect(result.blockedMessageCount).toBe(1);
  });

  it("⑤ 上下文准入：信息类消息不得注入", async () => {
    const controller = new ContextAdmissionController({
      stateDirectory: path.join(stateDirectory, "context"),
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    const result = await controller.admit({
      partitionKey,
      recipientIdentifier: "agent:main",
      messageIdentifier: "message-info",
      admissionClass: "archive-only",
    });
    expect(result).toMatchObject({ outcome: "archived-only", isInjected: false, isResumeRequested: false });
  });
});
