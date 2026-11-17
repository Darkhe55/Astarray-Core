/**
 * COORD-01-03 §5（审查报告 P1 第二步，2026-11-16）：**协调消息正文必须真的进入模型请求**。
 *
 * 配置：准入消息 → 未投递（pending）→ Worker 本轮请求携带其正文 → 首个事件后标记 delivered。
 * 反例会实际**捕获模型请求**（systemPrompt），断言正文、来源、任务与"待处理"标注都在其中；
 * 只断言状态字段不算验证（审查报告明确要求）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { ContextAdmissionController } from "../../../packages/core/src/orchestration/context-admission.js";
import { createCoordinationContextDeliveryPort } from "../../../packages/core/src/orchestration/coordination-context-delivery.js";
import { WorkerAgent } from "../../../packages/core/src/orchestration/worker-agent.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord-delivery-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const RECIPIENT = "agent:worker-1";

async function seedAdmittedMessage(
  journal: MailboxJournal,
  admission: ContextAdmissionController,
) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId: "coord-message-1",
    source: { sourceType: "agent", agentInstanceId: "agent-requester-9" },
    recipientId: RECIPIENT,
    priority: "state",
    createdAtIso: "2026-11-16T00:00:00.000Z",
    idempotencyKey: "coord-message-1",
    taskIdentifier: "T-777",
    payload: {
      kind: "clarification-request",
      summary: "需要确认是否继续合并",
      unresolvedQuestions: ["是否继续合并"],
    },
  } as never);
  const message = (await journal.loadDocument(RECIPIENT))?.messages.find(
    (candidate) => candidate.messageId === "coord-message-1",
  );
  expect(message).toBeDefined();
  await journal.setContextDeliveryState({
    recipientId: RECIPIENT,
    messageId: "coord-message-1",
    contextDeliveryState: "pending",
  });
  await admission.admit({
    partitionKey: "partition-1",
    recipientIdentifier: RECIPIENT,
    messageIdentifier: "coord-message-1",
    admissionClass: "requires-model-decision",
  });
}

function buildWorker(input: {
  journal: MailboxJournal;
  admission: ContextAdmissionController;
  capturedPrompts: string[];
  /** P1-3：可注入的运行期门禁/自定义 runtime/取消信号，用于"未提交"反例。 */
  workWindowGate?: (gateInput: { gatePoint: "model" | "tool-execution" }) =>
    | { kind: "allow"; reason: string }
    | { kind: "deny"; reason: string };
  runtime?: unknown;
  cancellationSignal?: AbortSignal;
}) {
  const port = createCoordinationContextDeliveryPort({
    journal: input.journal,
    admissionController: input.admission,
    partitionKey: "partition-1",
  });
  const workerOptions: Record<string, unknown> = {
    agentInstanceId: "worker-1",
    missionId: "mission-1",
    task: {
      id: "T-777",
      description: "执行任务",
      dependsOn: [],
      taskType: "data",
      toolNames: [],
      status: "running",
      assignedAgentId: "worker-1",
      resultLocation: null,
    },
    runtime:
      input.runtime ??
      {
        async *run(runInput: { systemPrompt: string }) {
          input.capturedPrompts.push(runInput.systemPrompt);
          yield { kind: "textDelta", deltaText: "已收到" };
        },
      },
    toolPort: { execute: async () => ({ kind: "success", callId: "c-1", outputText: "" }) },
    failureCounter: { recordFailure: () => false, recordSuccess: () => {} },
    feedbackTransport: { setAgentStatus: () => {}, enqueue: async () => 1 },
    maxLoopIterations: 2,
    buildPermissionExplanation: () => "why",
    coordinationContextDeliveryPort: port,
  };
  if (input.workWindowGate !== undefined) {
    workerOptions["workWindowGate"] = input.workWindowGate;
  }
  if (input.cancellationSignal !== undefined) {
    workerOptions["cancellationSignal"] = input.cancellationSignal;
  }
  return new WorkerAgent(workerOptions as never);
}

describe("协调上下文投递（真实请求携带）", () => {
  it("① 模型请求携带消息正文/来源/任务，且标注为待处理而非已完成事实", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const admission = new ContextAdmissionController({ stateDirectory: baseDirectory });
    await seedAdmittedMessage(journal, admission);

    const capturedPrompts: string[] = [];
    const worker = buildWorker({ journal, admission, capturedPrompts });
    await worker.run();

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("[待处理的协调消息]");
    expect(prompt).toContain("coord-message-1");
    expect(prompt).toContain("agent-requester-9");
    expect(prompt).toContain("T-777");
    expect(prompt).toContain("需要确认是否继续合并");
    /** 不得把待处理消息说成已完成事实。 */
    expect(prompt).toContain("不是已完成的事实");
  });

  it("② 请求提交后才标 delivered：journal 状态与准入回执同时更新，且带回请求标识", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const admission = new ContextAdmissionController({ stateDirectory: baseDirectory });
    await seedAdmittedMessage(journal, admission);

    const worker = buildWorker({ journal, admission, capturedPrompts: [] });
    await worker.run();

    const [view] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "coord-message-1",
    });
    expect(view?.contextDeliveryState).toBe("delivered");

    const receipt = await admission.readInjectionReceipt({
      partitionKey: "partition-1",
      messageIdentifier: "coord-message-1",
    });
    expect(receipt?.deliveredAtIso).not.toBeNull();
    expect(receipt?.deliveryRequestIdentifier).toContain("worker-turn:T-777");
  });

  it("③ 没有 pending 消息 ⇒ 请求里没有该区块（不无中生有）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const admission = new ContextAdmissionController({ stateDirectory: baseDirectory });
    const capturedPrompts: string[] = [];
    const worker = buildWorker({ journal, admission, capturedPrompts });
    await worker.run();
    expect(capturedPrompts[0] ?? "").not.toContain("[待处理的协调消息]");
  });
});
describe("P1-3：未提交不得标 delivered", () => {
  it("④ 工作时段门禁在模型调用前拒绝 ⇒ 保持 pending（不得标 delivered）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const admission = new ContextAdmissionController({ stateDirectory: baseDirectory });
    await seedAdmittedMessage(journal, admission);

    const worker = buildWorker({
      journal,
      admission,
      capturedPrompts: [],
      workWindowGate: () => ({ kind: "deny", reason: "工作时段已关闭" }),
    });
    await worker.run().catch(() => undefined);

    const [view] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "coord-message-1",
    });
    expect(view?.contextDeliveryState).toBe("pending");
  });

  it("⑤ 请求发起即失败（未收到任何事件）⇒ 记 unknown，不冒充 delivered", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const admission = new ContextAdmissionController({ stateDirectory: baseDirectory });
    await seedAdmittedMessage(journal, admission);

    const worker = buildWorker({
      journal,
      admission,
      capturedPrompts: [],
      runtime: {
        // eslint-disable-next-line require-yield
        async *run() {
          throw new Error("连接中断：结果未知");
        },
      },
    });
    await worker.run().catch(() => undefined);

    const [view] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "coord-message-1",
    });
    expect(view?.contextDeliveryState).toBe("unknown");
  });

  it("⑥ 请求前取消 ⇒ 保持 pending", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const admission = new ContextAdmissionController({ stateDirectory: baseDirectory });
    await seedAdmittedMessage(journal, admission);

    const worker = buildWorker({ journal, admission, capturedPrompts: [] });
    /** 请求前取消：worker 自己的取消信号已置位，工具循环不得触发"已提交"回调。 */
    worker.cancel();
    await worker.run().catch(() => undefined);

    const [view] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "coord-message-1",
    });
    expect(view?.contextDeliveryState).toBe("pending");
  });
});

describe("P1-3 要求 7：按预算部分携带", () => {
  function buildEntry(identifier: string) {
    return {
      messageIdentifier: identifier,
      sourceIdentifier: "agent-requester",
      taskIdentifier: "T-777",
      summaryText: "x".repeat(40),
      enqueuedSequence: 1,
    };
  }

  it("⑦ 超预算的条目被排除，且不进入提示词", async () => {
    const { selectCoordinationContextEntries, formatCoordinationContextBlock } = await import(
      "../../../packages/core/src/orchestration/coordination-context-delivery.js"
    );
    const selection = selectCoordinationContextEntries({
      entries: [buildEntry("m-1"), buildEntry("m-2"), buildEntry("m-3")],
      maximumCharacterCount: 70,
    });
    expect(selection.includedEntries.map((entry) => entry.messageIdentifier)).toEqual(["m-1"]);
    expect(selection.excludedMessageIdentifiers).toEqual(["m-2", "m-3"]);
    const block = formatCoordinationContextBlock(selection.includedEntries);
    expect(block).toContain("m-1");
    expect(block).not.toContain("m-2");
  });
});
