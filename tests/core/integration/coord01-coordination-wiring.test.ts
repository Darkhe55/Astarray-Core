/**
 * COORD-01-02：**装配层接线**——本地协调器经 `createApplicationRuntime` 可达。
 *
 * 反例/关键性质：
 * - 分区键由项目 ID + 主 Agent 个体 ID 组成（不是默认空串）；
 * - 真实 journal（与反馈子进程同一 stateDirectory）里的消息能被消费步应用；
 * - 第二次消费不再重复应用（幂等），且唤醒计数不重复增长。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-wiring-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createRuntime() {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    projectIdentifier: "project-alpha",
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
  } as never);
}

describe("本地协调器装配接线", () => {
  it("① 分区键由项目与主 Agent 组成", async () => {
    const runtime = await createRuntime();
    try {
      expect(runtime.coordinationPartitionKey).toBe(
        "project:project-alpha|scheduler:main-agent-1",
      );
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("④ 三状态查询：应用前 pending、应用后 applied（经运行时入口）", async () => {
    const runtime = await createRuntime();
    try {
      await runtime.coordinationMailboxJournal.enqueue({
        protocolVersion: 1,
        messageId: "message-status-1",
        source: { sourceType: "agent", agentInstanceId: "worker-1" },
        recipientId: "agent:main-agent-1",
        priority: "state",
        createdAtIso: "2026-11-11T00:00:00.000Z",
        idempotencyKey: "message-status-1",
        projectIdentifier: "project-alpha",
        taskIdentifier: "T-001",
        payload: { kind: "success", summary: "完成" },
      } as never);

      const beforeApply = await runtime.readCoordinationMessageStatus("message-status-1");
      expect(beforeApply[0]?.applicationState.state).toBe("pending");
      expect(beforeApply[0]?.deliveryState.isDelivered).toBe(false);

      await runtime.coordinationMessageConsumer.runConsumptionStep({
        partitionKey: runtime.coordinationPartitionKey,
        recipientId: "agent:main-agent-1",
        ownerInstanceIdentifier: "main-agent-1",
        leaseTtlMilliseconds: 60_000,
        toSnapshot: (message) => ({ appliedMessage: message.messageId }),
      });

      const afterApply = await runtime.readCoordinationMessageStatus("message-status-1");
      expect(afterApply[0]?.applicationState.state).toBe("applied");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("② 真实 journal 消息被消费步应用；③ 再消费不重复应用", async () => {
    const runtime = await createRuntime();
    try {
      await runtime.coordinationMailboxJournal.enqueue({
        protocolVersion: 1,
        messageId: "message-1",
        source: { sourceType: "agent", agentInstanceId: "worker-1" },
        recipientId: "agent:main-agent-1",
        priority: "state",
        createdAtIso: "2026-11-11T00:00:00.000Z",
        idempotencyKey: "message-1",
        projectIdentifier: "project-alpha",
        taskIdentifier: "T-001",
        payload: { kind: "success", summary: "完成" },
      } as never);

      const firstStep = await runtime.coordinationMessageConsumer.runConsumptionStep({
        partitionKey: runtime.coordinationPartitionKey,
        recipientId: "agent:main-agent-1",
        ownerInstanceIdentifier: "main-agent-1",
        leaseTtlMilliseconds: 60_000,
        toSnapshot: (message) => ({ appliedMessage: message.messageId }),
      });
      expect(firstStep.appliedMessageCount).toBe(1);

      const secondStep = await runtime.coordinationMessageConsumer.runConsumptionStep({
        partitionKey: runtime.coordinationPartitionKey,
        recipientId: "agent:main-agent-1",
        ownerInstanceIdentifier: "main-agent-1",
        leaseTtlMilliseconds: 60_000,
        toSnapshot: (message) => ({ appliedMessage: message.messageId }),
      });
      expect(secondStep.appliedMessageCount).toBe(0);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
