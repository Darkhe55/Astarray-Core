/**
 * COORD-01-03（卡 §5）：**上下文准入**。
 *
 * 反例优先：
 * - 普通进度/摘要 ⇒ **不进上下文**、不请求续跑；
 * - 带未决问题或显式要求模型决策 ⇒ 注入；
 * - 同一消息重复注入 ⇒ 只记一次回执；
 * - 注入回执**不等于**续跑请求（`isResumeRequested` 恒为 false）；
 * - 注入回执与应用状态**分开**（journal 的 applicationState 不受影响）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import {
  ContextAdmissionController,
  classifyContextAdmission,
} from "../../../packages/core/src/orchestration/context-admission.js";

let stateDirectory: string;
const partitionKey = "project:project-alpha|scheduler:scheduler-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-context-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildController() {
  return new ContextAdmissionController({
    stateDirectory: path.join(stateDirectory, "context"),
  });
}

describe("上下文准入", () => {
  it("① 普通进度 ⇒ archive-only，不注入、不请求续跑", () => {
    const admissionClass = classifyContextAdmission({ payload: { kind: "success" } });
    expect(admissionClass).toBe("archive-only");
  });

  it("② 未决问题 / 显式要求模型决策 ⇒ 需要模型处理", () => {
    expect(classifyContextAdmission({ payload: { unresolvedQuestions: ["要不要继续"] } })).toBe(
      "requires-model-decision",
    );
    expect(classifyContextAdmission({ payload: { requiresModelDecision: true } })).toBe(
      "requires-model-decision",
    );
  });

  it("③ 注入一次；重复注入只记一次回执（幂等）", async () => {
    const controller = buildController();
    const first = await controller.admit({
      partitionKey,
      recipientIdentifier: "agent:main",
      messageIdentifier: "message-1",
      admissionClass: "requires-model-decision",
    });
    expect(first).toMatchObject({ outcome: "injected", isInjected: true, isResumeRequested: false });

    const second = await controller.admit({
      partitionKey,
      recipientIdentifier: "agent:main",
      messageIdentifier: "message-1",
      admissionClass: "requires-model-decision",
    });
    expect(second.outcome).toBe("duplicate-injection-ignored");
    expect(second.isInjected).toBe(false);
  });

  it("④ archive-only ⇒ 不注入、不请求续跑", async () => {
    const controller = buildController();
    const result = await controller.admit({
      partitionKey,
      recipientIdentifier: "agent:main",
      messageIdentifier: "message-2",
      admissionClass: "archive-only",
    });
    expect(result).toMatchObject({ outcome: "archived-only", isInjected: false, isResumeRequested: false });
    expect(
      await controller.readInjectionReceipt({ partitionKey, messageIdentifier: "message-2" }),
    ).toBeNull();
  });

  it("⑤ 注入回执与应用状态分开：journal 的 applicationState 不被写", async () => {
    const journal = new MailboxJournal(path.join(stateDirectory, "journal"));
    await journal.enqueue({
      protocolVersion: 1,
      messageId: "message-3",
      source: { sourceType: "agent", agentInstanceId: "worker-1" },
      recipientId: "scheduler:mission-1",
      priority: "state",
      createdAtIso: "2026-11-11T00:00:00.000Z",
      idempotencyKey: "message-3",
      payload: { kind: "success", summary: "完成" },
    } as never);

    const controller = buildController();
    await controller.admit({
      partitionKey,
      recipientIdentifier: "scheduler:mission-1",
      messageIdentifier: "message-3",
      admissionClass: "requires-model-decision",
    });

    const [view] = await journal.readMessageStatusView({
      recipientId: "scheduler:mission-1",
      messageId: "message-3",
    });
    expect(view?.applicationState.state).toBe("pending");
    expect(
      (await controller.readInjectionReceipt({ partitionKey, messageIdentifier: "message-3" }))
        ?.messageIdentifier,
    ).toBe("message-3");
  });
});
