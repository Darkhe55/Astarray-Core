/**
 * COORD-05 05-02（2026-11-22）：逐级请示契约与路由。
 *
 * 覆盖：真实管理树解析（含环）、方向校验、用户通道、处置链追加（当前处理人 + 版本保护）、
 * 终态后不再接受追加（中间层结案 ⇒ 上层零消息）。
 */
import { describe, expect, it } from "vitest";

import {
  appendEscalationDisposition,
  resolveEscalationChain,
  resolveEscalationTarget,
  type EscalationRecord,
} from "../../../packages/core/src/orchestration/escalation-contract.js";

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
});
