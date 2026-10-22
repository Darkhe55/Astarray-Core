/**
 * COMM-01-02 主体反例（2026-10-22）：跨项目只读协作的授权与信封校验。
 *
 * 覆盖卡内：请求方不得自批、批准者须属目标项目、授权须绑对象/角色范围 + 消息类型 + 用途 + 有效期、
 * 只读（写入一律拒）、旧 revision 拒绝、跨项目不可再转授权、接收者不在范围拒绝、
 * 建议采纳不等于执行批准、目标不可用不回退同名对象、信封缺地址拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateCrossProjectDelivery,
  issueCrossProjectAuthorization,
  planSuggestionAdoption,
  revokeCrossProjectAuthorization,
  type CrossProjectAuthorization,
  type CrossProjectEnvelope,
} from "../../../packages/core/src/orchestration/cross-project-collaboration.js";

const issuedAtIso = "2026-10-22T10:00:00.000Z";
const expiresAtIso = "2026-10-23T10:00:00.000Z";
const nowIso = "2026-10-22T12:00:00.000Z";

function grant(overrides: Record<string, unknown> = {}) {
  return issueCrossProjectAuthorization({
    authorizationIdentifier: "auth-1",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    requestingAgentInstanceId: "agent-a1",
    grantor: { kind: "authenticated-user", userId: "user-1" },
    scope: { kind: "specific-agent", agentInstanceId: "agent-b1" },
    allowedMessageKinds: ["status-query", "suggestion", "correlated-reply"],
    purpose: "只读查询项目 B 的构建状态并提交建议",
    issuedAtIso,
    expiresAtIso,
    revision: 1,
    ...overrides,
  });
}

function authorization(): CrossProjectAuthorization {
  const outcome = grant();
  if (outcome.kind !== "granted") throw new Error("夹具授权应成功");
  return outcome.authorization;
}

function envelope(overrides: Partial<CrossProjectEnvelope> = {}): CrossProjectEnvelope {
  return {
    messageIdentifier: "message-1",
    idempotencyKey: "idem-1",
    senderAgentInstanceId: "agent-a1",
    recipientAgentInstanceId: "agent-b1",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    sourceSessionIdentifier: "session-a",
    targetSessionIdentifier: null,
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    authorizationRevision: 1,
    messageKind: "status-query",
    correlationIdentifier: null,
    replyToMessageIdentifier: null,
    intendedAction: "read",
    ...overrides,
  };
}

describe("COMM-01-02 跨项目只读授权签发", () => {
  it("① 认证用户给目标项目授权 ⇒ granted，且只读、不可再转授权", () => {
    const outcome = grant();
    expect(outcome.kind).toBe("granted");
    if (outcome.kind !== "granted") throw new Error("unreachable");
    expect(outcome.authorization.isReadOnly).toBe(true);
    expect(outcome.authorization.canBeRedelegated).toBe(false);
  });

  it("② **请求方不能自批**（目标项目主 Agent 恰好是请求者）⇒ 拒绝", () => {
    const outcome = grant({
      grantor: { kind: "target-project-main-agent", agentInstanceId: "agent-a1", projectIdentifier: "project-b" },
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "self-approval-forbidden" });
  });

  it("③ 批准者不属于目标项目 ⇒ 拒绝（模型自称不构成授权）", () => {
    const outcome = grant({
      grantor: { kind: "target-project-main-agent", agentInstanceId: "agent-x", projectIdentifier: "project-c" },
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "grantor-not-target-project" });
  });

  it("④ 缺用途 / 缺范围 / 空角色范围 ⇒ 拒绝", () => {
    expect(grant({ purpose: "  " })).toMatchObject({ kind: "rejected", reasonCode: "missing-purpose" });
    expect(grant({ scope: null })).toMatchObject({ kind: "rejected", reasonCode: "missing-scope" });
    expect(grant({ scope: { kind: "role-range", roleIdentifiers: [] } })).toMatchObject({
      kind: "rejected",
      reasonCode: "missing-scope",
    });
  });

  it("⑤ 允许的只是只读类型；带写入类型 ⇒ 拒绝", () => {
    expect(grant({ allowedMessageKinds: ["write-file"] })).toMatchObject({
      kind: "rejected",
      reasonCode: "write-scope-forbidden",
    });
    expect(grant({ allowedMessageKinds: ["status-query", "write-file"] })).toMatchObject({
      kind: "rejected",
      reasonCode: "write-scope-forbidden",
    });
  });

  it("⑥ 有效期必须晚于签发时间 ⇒ 否则拒绝", () => {
    expect(grant({ expiresAtIso: "2026-10-22T09:00:00.000Z" })).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-validity-window",
    });
  });
});

describe("COMM-01-02 投递前校验", () => {
  it("⑦ 合规信封 ⇒ allowed（只读动作）", () => {
    expect(
      evaluateCrossProjectDelivery({ envelope: envelope(), authorization: authorization(), nowIso }),
    ).toEqual({ kind: "allowed", authorizationRevision: 1 });
  });

  it("⑧ 无授权 ⇒ 拒绝（跨项目必须按需申请）", () => {
    expect(evaluateCrossProjectDelivery({ envelope: envelope(), authorization: null, nowIso })).toMatchObject({
      kind: "rejected",
      reasonCode: "authorization-not-found",
    });
  });

  it("⑨ 授权撤销后 ⇒ 拒绝在途旧消息", () => {
    const revoked = revokeCrossProjectAuthorization(authorization());
    expect(
      evaluateCrossProjectDelivery({ envelope: envelope({ authorizationRevision: 2 }), authorization: revoked, nowIso }),
    ).toMatchObject({ kind: "rejected", reasonCode: "authorization-revoked" });
  });

  it("⑩ 过期 ⇒ 拒绝", () => {
    expect(
      evaluateCrossProjectDelivery({ envelope: envelope(), authorization: authorization(), nowIso: "2026-10-24T00:00:00.000Z" }),
    ).toMatchObject({ kind: "rejected", reasonCode: "authorization-expired" });
  });

  it("⑪ 旧/新 revision 不匹配 ⇒ 拒绝（不落到新任务）", () => {
    expect(
      evaluateCrossProjectDelivery({ envelope: envelope({ authorizationRevision: 0 }), authorization: authorization(), nowIso }),
    ).toMatchObject({ kind: "rejected", reasonCode: "authorization-revision-stale" });
  });

  it("⑫ 源/目标项目不符 ⇒ 拒绝（不可转授权到其他项目）", () => {
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ targetProjectIdentifier: "project-c" }),
        authorization: authorization(),
        nowIso,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "wrong-target-project" });
  });

  it("⑬ 发送者不是被授权 Agent ⇒ 拒绝", () => {
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ senderAgentInstanceId: "agent-other" }),
        authorization: authorization(),
        nowIso,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "sender-not-authorized-agent" });
  });

  it("⑭ 接收者不在具体对象范围 ⇒ 拒绝；角色范围内则放行", () => {
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ recipientAgentInstanceId: "agent-b2" }),
        authorization: authorization(),
        nowIso,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "role-scope-mismatch" });

    const roleGrant = grant({ scope: { kind: "role-range", roleIdentifiers: ["reviewer"] } });
    if (roleGrant.kind !== "granted") throw new Error("role 授权应成功");
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ recipientAgentInstanceId: "agent-b2" }),
        authorization: roleGrant.authorization,
        nowIso,
        targetRoleIdentifiers: ["reviewer"],
      }),
    ).toEqual({ kind: "allowed", authorizationRevision: 1 });
  });

  it("⑮ 消息类型不在授权范围 ⇒ 拒绝", () => {
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ messageKind: "artifact-query" }),
        authorization: authorization(),
        nowIso,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "message-kind-not-allowed" });
  });

  it("⑯ 跨项目写动作 ⇒ 一律拒绝（建议请走建议入口）", () => {
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ intendedAction: "write-file" }),
        authorization: authorization(),
        nowIso,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "write-action-forbidden" });
  });

  it("⑰ 目标个体已回收/未知 ⇒ 拒绝，不回退同名对象", () => {
    expect(
      evaluateCrossProjectDelivery({ envelope: envelope(), authorization: authorization(), nowIso, targetLifecycle: "recycled" }),
    ).toMatchObject({ kind: "rejected", reasonCode: "receiver-unavailable" });
  });

  it("⑱ 信封缺地址字段 ⇒ 拒绝（禁止自由文本补齐）", () => {
    expect(
      evaluateCrossProjectDelivery({
        envelope: envelope({ recipientAgentInstanceId: "  " }),
        authorization: authorization(),
        nowIso,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "envelope-incomplete" });
  });

  it("⑲ 建议采纳：目标项目自建任务，且**不带执行批准**", () => {
    const plan = planSuggestionAdoption({
      messageIdentifier: "message-1",
      sourceProjectIdentifier: "project-a",
      sourceAgentInstanceId: "agent-a1",
      authorizationIdentifier: "auth-1",
      targetProjectIdentifier: "project-b",
      adoptedByAgentInstanceId: "agent-b1",
      proposedTaskIdentifier: "task-adopted-1",
    });
    expect(plan.adoptedTaskIdentifier).toBe("task-adopted-1");
    expect(plan.isExecutionApproved).toBe(false);
    expect(plan.requiresTargetProjectAuthorization).toBe(true);
  });
});
