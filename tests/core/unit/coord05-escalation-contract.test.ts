/**
 * COORD-05 05-02（2026-11-22）：逐级请示契约与路由。
 *
 * 覆盖：真实管理树解析（含环）、方向校验、用户通道、处置链追加（当前处理人 + 版本保护）、
 * 终态后不再接受追加（中间层结案 ⇒ 上层零消息）。
 */
import { describe, expect, it } from "vitest";

import {
  appendEscalationDisposition,
  openEscalation,
  resolveEscalationChain,
  resolveEscalationTarget,
  type EscalationRecord,
} from "../../../packages/core/src/orchestration/escalation-contract.js";
import { feedbackMessageSchema } from "../../../packages/core/src/core/schemas.js";

/** 管理树：w1 → s1 → m1 → null（主层）。 */
const creators: Record<string, string | null> = {
  w1: "s1",
  s1: "m1",
  m1: null,
};

async function resolveCreatorOf(agentInstanceId: string): Promise<string | null> {
  return creators[agentInstanceId] ?? null;
}

async function isAgentKnown(agentInstanceId: string): Promise<boolean> {
  return agentInstanceId in creators;
}

const baseRecord: EscalationRecord = {
  requestIdentifier: "escalation-1",
  originalInitiatorAgentInstanceId: "w1",
  projectIdentifier: "p1",
  missionIdentifier: "m-1",
  taskIdentifier: "T-1",
  affectedStepIdentifiers: ["step-export"],
  questionSummary: "导出口径需要确认",
  documentReferences: [{ documentIdentifier: "docs/export.md", revision: 3 }],
  currentHandlerAgentInstanceId: "s1",
  version: 1,
  state: "open",
  dispositions: [],
};

describe("COORD-05 05-02：逐级请示路由", () => {
  it("① worker 的上报链是 [直属上级, 主层]；单跳目标为直属上级", async () => {
    const chain = await resolveEscalationChain({
      senderAgentInstanceId: "w1",
      resolveCreatorOf,
      isAgentKnown,
    });
    expect(chain).toEqual({ kind: "user", chain: ["s1", "m1"] });

    const target = await resolveEscalationTarget({
      senderAgentInstanceId: "w1",
      resolveCreatorOf,
      isAgentKnown,
    });
    expect(target).toEqual({ kind: "agent", agentInstanceId: "s1", chain: ["s1", "m1"] });
  });

  it("② 主层无上级 ⇒ 目标是用户裁决通道（不征询同级）", async () => {
    const target = await resolveEscalationTarget({
      senderAgentInstanceId: "m1",
      resolveCreatorOf,
      isAgentKnown,
    });
    expect(target).toEqual({ kind: "user", chain: [] });
  });

  it("③ 创建关系成环 ⇒ 拒绝（不猜测上级）", async () => {
    const target = await resolveEscalationTarget({
      senderAgentInstanceId: "a1",
      resolveCreatorOf: async (agentInstanceId) =>
        ({ a1: "b1", b1: "a1" })[agentInstanceId] ?? null,
      isAgentKnown: async (agentInstanceId) => agentInstanceId === "a1" || agentInstanceId === "b1",
    });
    expect(target.kind).toBe("refused");
    if (target.kind !== "refused") return;
    expect(target.code).toBe("cycle-detected");
    expect(target.reason).toContain("成环");
  });

  it("④ 未登记的发送者 ⇒ 拒绝", async () => {
    const target = await resolveEscalationTarget({
      senderAgentInstanceId: "ghost",
      resolveCreatorOf,
      isAgentKnown,
    });
    expect(target).toMatchObject({ kind: "refused", code: "unknown-sender" });
  });

  it("⑤ 越级/改投 ⇒ 方向违规", async () => {
    const target = await resolveEscalationTarget({
      senderAgentInstanceId: "w1",
      proposedRecipientAgentInstanceId: "m1",
      resolveCreatorOf,
      isAgentKnown,
    });
    expect(target).toMatchObject({ kind: "refused", code: "direction-violation" });
  });

  it("⑥ 本层结案 ⇒ 终态，后续追加被拒（上层零消息）", () => {
    const first = appendEscalationDisposition({
      record: baseRecord,
      expectedVersion: 1,
      handlerAgentInstanceId: "s1",
      disposition: "resolved",
      reason: "本层有材料，直接拍板",
      referencedDocumentIdentifiers: ["docs/export.md"],
      handledAtIso: "2026-11-22T00:00:00.000Z",
    });
    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") return;
    expect(first.record.state).toBe("resolved-by-agent");
    expect(first.record.dispositions).toHaveLength(1);

    const second = appendEscalationDisposition({
      record: first.record,
      expectedVersion: first.record.version,
      handlerAgentInstanceId: "s1",
      disposition: "forwarded",
      reason: "再往上转",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:00:01.000Z",
      forwardToAgentInstanceId: "m1",
    });
    expect(second).toMatchObject({ kind: "refused", code: "already-terminal" });
  });

  it("⑦ 转交：处理人变更、版本递增、处置链只追加", () => {
    const outcome = appendEscalationDisposition({
      record: baseRecord,
      expectedVersion: 1,
      handlerAgentInstanceId: "s1",
      disposition: "forwarded",
      reason: "超出本层权限，转交主层",
      referencedDocumentIdentifiers: ["docs/export.md"],
      handledAtIso: "2026-11-22T00:00:00.000Z",
      forwardToAgentInstanceId: "m1",
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") return;
    expect(outcome.record.currentHandlerAgentInstanceId).toBe("m1");
    expect(outcome.record.version).toBe(2);
    expect(outcome.record.state).toBe("open");
    expect(outcome.record.dispositions[0]?.agentInstanceId).toBe("s1");
  });

  it("⑧ 版本过期 / 非当前处理人 / 非法转交目标 ⇒ 拒绝且不改状态", () => {
    const stale = appendEscalationDisposition({
      record: baseRecord,
      expectedVersion: 0,
      handlerAgentInstanceId: "s1",
      disposition: "resolved",
      reason: "x",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:00:00.000Z",
    });
    expect(stale).toMatchObject({ kind: "refused", code: "stale-version" });

    const wrongHandler = appendEscalationDisposition({
      record: baseRecord,
      expectedVersion: 1,
      handlerAgentInstanceId: "m1",
      disposition: "resolved",
      reason: "x",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:00:00.000Z",
    });
    expect(wrongHandler).toMatchObject({ kind: "refused", code: "handler-mismatch" });

    const selfForward = appendEscalationDisposition({
      record: baseRecord,
      expectedVersion: 1,
      handlerAgentInstanceId: "s1",
      disposition: "forwarded",
      reason: "x",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:00:00.000Z",
      forwardToAgentInstanceId: "s1",
    });
    expect(selfForward).toMatchObject({ kind: "refused", code: "invalid-forward-target" });
  });

  it("⑨ 打开请示：worker ⇒ 处理人为直属上级，字段原样保留", async () => {
    const outcome = await openEscalation(
      {
        requestIdentifier: "escalation-1",
        senderAgentInstanceId: "w1",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: ["step-export"],
        questionSummary: "导出口径需要确认",
        documentReferences: [{ documentIdentifier: "docs/export.md", revision: 3 }],
        nowIso: "2026-11-22T00:00:00.000Z",
      },
      { resolveCreatorOf, isAgentKnown },
    );
    expect(outcome.kind).toBe("opened");
    if (outcome.kind !== "opened") return;
    expect(outcome.target).toEqual({ kind: "agent", agentInstanceId: "s1" });
    expect(outcome.record.currentHandlerAgentInstanceId).toBe("s1");
    expect(outcome.record.originalInitiatorAgentInstanceId).toBe("w1");
    expect(outcome.record.affectedStepIdentifiers).toEqual(["step-export"]);
    expect(outcome.record.documentReferences).toEqual([
      { documentIdentifier: "docs/export.md", revision: 3 },
    ]);
    expect(outcome.record.state).toBe("open");
    expect(outcome.record.version).toBe(1);
  });

  it("⑩ 主层无法决断 ⇒ 处理人为用户通道（null），不征询同级", async () => {
    const outcome = await openEscalation(
      {
        requestIdentifier: "escalation-2",
        senderAgentInstanceId: "m1",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: [],
        questionSummary: "需要用户拍板",
        documentReferences: [],
        nowIso: "2026-11-22T00:00:00.000Z",
      },
      { resolveCreatorOf, isAgentKnown },
    );
    expect(outcome.kind).toBe("opened");
    if (outcome.kind !== "opened") return;
    expect(outcome.target).toEqual({ kind: "user" });
    expect(outcome.record.currentHandlerAgentInstanceId).toBeNull();
  });

  it("⑪ 未登记发送者 / 空请求标识 ⇒ 拒绝", async () => {
    const unknown = await openEscalation(
      {
        requestIdentifier: "escalation-3",
        senderAgentInstanceId: "ghost",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: [],
        questionSummary: "x",
        documentReferences: [],
        nowIso: "2026-11-22T00:00:00.000Z",
      },
      { resolveCreatorOf, isAgentKnown },
    );
    expect(unknown).toMatchObject({ kind: "refused", code: "unknown-sender" });

    const empty = await openEscalation(
      {
        requestIdentifier: " ",
        senderAgentInstanceId: "w1",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: [],
        questionSummary: "x",
        documentReferences: [],
        nowIso: "2026-11-22T00:00:00.000Z",
      },
      { resolveCreatorOf, isAgentKnown },
    );
    expect(empty).toMatchObject({ kind: "refused", code: "invalid-input" });
  });
});

describe("COORD-05 05-02：请示信封字段（schema 往返）", () => {
  const baseMessage = {
    protocolVersion: 1,
    messageId: "a3f7e2c1-9f0b-4a1c-8d2e-6b5a4c3d2e1f",
    source: {
      sourceType: "agent",
      agentInstanceId: "worker-a-019ff3fa",
      agentRole: "tertiary",
    },
    recipientId: "scheduler-1",
    priority: "instruction",
    createdAtIso: "2026-11-22T00:00:00.000Z",
    idempotencyKey: "escalation-1",
    payload: {
      kind: "collaboration-request",
      messageIdentifier: "collaboration-1",
      correlationIdentifier: "correlation-1",
      taskIdentifier: "T-1",
      summary: "请示",
      authorizationEpoch: 1,
      hopCount: 0,
    },
  };

  it("⑫ 请示字段经 schema 往返后仍在（zod 不剥离）", () => {
    const message = {
      ...baseMessage,
      escalationRequestIdentifier: "escalation-1",
      originalInitiatorAgentInstanceId: "w1",
      affectedStepIdentifiers: ["step-export"],
      documentReferences: [{ documentIdentifier: "docs/export.md", revision: 3 }],
    };
    const parsed = feedbackMessageSchema.parse(JSON.parse(JSON.stringify(message)));
    expect(parsed.escalationRequestIdentifier).toBe("escalation-1");
    expect(parsed.originalInitiatorAgentInstanceId).toBe("w1");
    expect(parsed.affectedStepIdentifiers).toEqual(["step-export"]);
    expect(parsed.documentReferences).toEqual([
      { documentIdentifier: "docs/export.md", revision: 3 },
    ]);
  });

  it("⑬ 空标识 / 空步骤 / 空引用 / 负 revision ⇒ 拒绝", () => {
    const base = {
      ...baseMessage,
      escalationRequestIdentifier: "escalation-1",
      originalInitiatorAgentInstanceId: "w1",
      affectedStepIdentifiers: ["step-export"],
      documentReferences: [{ documentIdentifier: "docs/export.md", revision: 3 }],
    };
    expect(
      feedbackMessageSchema.safeParse({ ...base, escalationRequestIdentifier: "" }).success,
    ).toBe(false);
    expect(
      feedbackMessageSchema.safeParse({ ...base, affectedStepIdentifiers: [] }).success,
    ).toBe(false);
    expect(
      feedbackMessageSchema.safeParse({ ...base, affectedStepIdentifiers: [""] }).success,
    ).toBe(false);
    expect(
      feedbackMessageSchema.safeParse({ ...base, documentReferences: [] }).success,
    ).toBe(false);
    expect(
      feedbackMessageSchema.safeParse({
        ...base,
        documentReferences: [{ documentIdentifier: "docs/export.md", revision: -1 }],
      }).success,
    ).toBe(false);
  });
});
