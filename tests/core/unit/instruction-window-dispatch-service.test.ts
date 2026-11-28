/**
 * MISSION-WRITE-01 切片 6（2026-11-28）：指令窗口准入/释放/补位派发服务（反例）。
 *
 * 语义保持：窗口满 ⇒ queued；无状态目录 ⇒ unwindowed；先回执再补位；只补一条；
 * 派发失败如实标 failed 并交失败回执；进行中标记串行化。
 */
import { describe, expect, it, vi } from "vitest";

import {
  InstructionWindowDispatchService,
  type InstructionWindowDispatchPorts,
  type InstructionWindowStorePort,
  type InstructionWindowTaskRecord,
} from "../../../packages/core/src/orchestration/instruction-window-dispatch-service.js";

function buildService(overrides: Partial<InstructionWindowDispatchPorts> = {}) {
  const queue: string[] = [];
  const records = new Map<string, InstructionWindowTaskRecord>();
  const receipts: Array<{ receiptOutcome: string; taskIdentifiers: string[] }> = [];
  let isDispatching = false;
  const store: InstructionWindowStorePort = {
    admitInstruction: vi.fn(async () => ({
      outcome: "windowed",
      instructionIdentifier: "task-instruction:task-1",
    })),
    submitReceipt: vi.fn(async (input) => {
      receipts.push({
        receiptOutcome: input.receiptOutcome,
        taskIdentifiers: [...input.taskIdentifiers],
      });
      return undefined;
    }),
  };
  const ports: InstructionWindowDispatchPorts = {
    isWindowEnabled: () => true,
    getStore: async () => store,
    createPublicError: (errorCode, message) => {
      const error = new Error(message);
      (error as Error & { errorCode?: string }).errorCode = errorCode;
      return error;
    },
    shiftQueuedTask: () => queue.shift(),
    removeQueuedTask: (taskIdentifier) => {
      const index = queue.indexOf(taskIdentifier);
      if (index < 0) return false;
      queue.splice(index, 1);
      return true;
    },
    findTaskRecord: (taskIdentifier) => records.get(taskIdentifier),
    listTaskEntries: () => [...records.entries()],
    emitTaskStatus: vi.fn(),
    emitTaskFinished: vi.fn(),
    startTaskMonitor: vi.fn(),
    submitPrompt: vi.fn(async () => "mission-1"),
    acquireDispatchLock: () => {
      if (isDispatching) return false;
      isDispatching = true;
      return true;
    },
    releaseDispatchLock: () => {
      isDispatching = false;
    },
    ...overrides,
  };
  return {
    service: new InstructionWindowDispatchService(ports),
    ports,
    queue,
    records,
    receipts,
    store,
  };
}

function makeRecord(overrides: Partial<InstructionWindowTaskRecord> = {}): InstructionWindowTaskRecord {
  return {
    sessionId: "session-1",
    missionIdentifier: null,
    status: "queued",
    revision: 0,
    instructionLink: { instructionIdentifier: "instr-1", instructionRevision: 1 },
    queuedPrompt: "排队提示词",
    summaryPreview: null,
    ...overrides,
  };
}

describe("MISSION-WRITE-01：指令窗口派发服务", () => {
  it("① 无状态目录 ⇒ unwindowed，不触达窗口存储", async () => {
    const getStore = vi.fn();
    const { service } = buildService({ isWindowEnabled: () => false, getStore });
    expect(await service.admitTaskInstruction({ sessionId: "s1", taskIdentifier: "t1", prompt: "p" })).toEqual({
      kind: "unwindowed",
    });
    expect(getStore).not.toHaveBeenCalled();
  });

  it("② 窗口内 ⇒ windowed 且 link 绑定任务指令；窗口幂等键含内容摘要", async () => {
    const { service, store } = buildService();
    const admission = await service.admitTaskInstruction({
      sessionId: "s1",
      taskIdentifier: "t1",
      prompt: "内容",
    });
    expect(admission.kind).toBe("windowed");
    const call = (store.admitInstruction as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      instructionIdentifier: string;
      idempotencyKey: string;
    };
    expect(call.instructionIdentifier).toBe("task-instruction:t1");
    expect(call.idempotencyKey.startsWith("task:s1:t1:")).toBe(true);
    expect(call.idempotencyKey).toHaveLength("task:s1:t1:".length + 16);
  });

  it("③ 窗口满 ⇒ queued（同一 link 形状）", async () => {
    const store = {
      admitInstruction: async () => ({ outcome: "queued", instructionIdentifier: "instr-q" }),
      submitReceipt: async () => undefined,
    };
    const { service } = buildService({ getStore: async () => store });
    const admission = await service.admitTaskInstruction({ sessionId: "s1", taskIdentifier: "t1", prompt: "p" });
    expect(admission).toEqual({
      kind: "queued",
      link: { instructionIdentifier: "instr-q", instructionRevision: 1 },
    });
  });

  it("④ 窗口幂等冲突 ⇒ idempotency-key-conflict（带任务标识文案）", async () => {
    const store = {
      admitInstruction: async () => ({ outcome: "idempotency-conflict", instructionIdentifier: "x" }),
      submitReceipt: async () => undefined,
    };
    const { service } = buildService({ getStore: async () => store });
    await expect(
      service.admitTaskInstruction({ sessionId: "s1", taskIdentifier: "t1", prompt: "p" }),
    ).rejects.toMatchObject({ errorCode: "idempotency-key-conflict" });
  });

  it("⑤ 释放槽位：先交回执再清 link，再补位一条；done⇒completed、cancelled⇒cancelled、failed⇒failed", async () => {
    for (const [terminalStatus, expected] of [
      ["done", "completed"],
      ["cancelled", "cancelled"],
      ["failed", "failed"],
    ] as const) {
      const { service, records, receipts, queue } = buildService();
      const record = makeRecord();
      records.set("task-1", record);
      queue.push("task-1");
      await service.releaseSlotAndDispatchNext(record, terminalStatus);
      expect(receipts[0]?.receiptOutcome).toBe(expected);
      expect(receipts[0]?.taskIdentifiers).toEqual(["task-1"]);
      expect(record.instructionLink).toBeNull();
    }
  });

  it("⑥ 补位只补一条：队首派发成功；并发第二次调用被进行中标记挡住", async () => {
    const submitPrompt = vi.fn(async () => "mission-next");
    const { service, records, queue } = buildService({ submitPrompt });
    const first = makeRecord({ status: "queued", instructionLink: null, queuedPrompt: "第一" });
    const second = makeRecord({ status: "queued", instructionLink: null, queuedPrompt: "第二" });
    records.set("task-1", first);
    records.set("task-2", second);
    queue.push("task-1", "task-2");
    await Promise.all([service.dispatchNextQueuedTask(), service.dispatchNextQueuedTask()]);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: "accepted", missionIdentifier: "mission-next" });
    expect(second.status).toBe("queued");
    expect(queue).toEqual(["task-2"]);
  });

  it("⑦ 补位派发失败 ⇒ 如实标 failed、发 task-finished、交失败回执并清 link（不静默丢队列）", async () => {
    const { service, records, queue, receipts, ports } = buildService({
      submitPrompt: async () => {
        throw new Error("boom");
      },
    });
    const record = makeRecord();
    records.set("task-1", record);
    queue.push("task-1");
    await service.dispatchNextQueuedTask();
    expect(record.status).toBe("failed");
    expect(record.summaryPreview).toBe("排队指令派发失败");
    expect(ports.emitTaskFinished).toHaveBeenCalledWith({
      taskIdentifier: "task-1",
      status: "failed",
      revision: 0,
    });
    expect(receipts[0]?.receiptOutcome).toBe("failed");
    expect(record.instructionLink).toBeNull();
  });

  it("⑧ taskIdentifierOf：按记录引用反查；找不到不猜", () => {
    const { service, records } = buildService();
    const record = makeRecord();
    records.set("task-1", record);
    expect(service.taskIdentifierOf(record)).toBe("task-1");
    expect(service.taskIdentifierOf(makeRecord())).toBe("unknown-task");
  });
});
