/**
 * COMM-01-02 主体（2026-10-22）：**跨项目只读协作**的授权与信封校验。
 *
 * 依据卡内 §2.1.1、§2.2、§2.3、§2.4：
 * 1. 跨项目连接**始终只读**：查询状态、读取资料、交换建议与关联回复；
 *    读取资料仍受 PROJECT-01 资源授权约束（通信许可 ≠ 读整项目/记忆）。
 * 2. 授权必须由**目标项目有权主 Agent 或认证用户**给出，绑定源/目标项目、
 *    具体对象或明确角色范围、消息类型、用途、有效期、revision，**可撤销**；
 *    **不可再转授权**；请求方不能自批。
 * 3. 地址一律 `agentInstanceId`；信封必须含接收者实例、源/目标 project/session、
 *    任务或 mission 引用、关系 revision、消息类型、`correlationId`、`replyToMessageId`、幂等键；
 *    **禁止用模型自由文本补齐地址**。
 * 4. 外来 Agent **不得写**目标项目（文件/配置/任务/权限/Git）；建议入口只登记建议，
 *    **通信批准 ≠ 执行批准**，采纳由目标项目自己建任务。
 *
 * 本模块只做**判定**（纯函数，便于逐条反例）；传输复用已交付的本地 mailbox / 反馈进程。
 */

/** 跨项目允许的消息类型（只读协作范围内）。 */
export const CROSS_PROJECT_MESSAGE_KINDS = [
  "status-query",
  "artifact-query",
  "suggestion",
  "correlated-reply",
] as const;
export type CrossProjectMessageKind = (typeof CROSS_PROJECT_MESSAGE_KINDS)[number];

/** 写入类动作：跨项目**一律拒绝**。 */
export const CROSS_PROJECT_WRITE_ACTIONS = [
  "write-file",
  "modify-config",
  "modify-task-graph",
  "modify-permission",
  "git-push",
  "install-package",
] as const;
export type CrossProjectWriteAction = (typeof CROSS_PROJECT_WRITE_ACTIONS)[number];

/** 授权粒度：具体对象或明确角色范围（二选一，不能都空）。 */
export type CrossProjectScope =
  | { readonly kind: "specific-agent"; readonly agentInstanceId: string }
  | { readonly kind: "role-range"; readonly roleIdentifiers: ReadonlyArray<string> };

/** 跨项目授权。 */
export interface CrossProjectAuthorization {
  readonly authorizationIdentifier: string;
  readonly sourceProjectIdentifier: string;
  readonly targetProjectIdentifier: string;
  /** 被授权的源项目 Agent（发起方）。 */
  readonly requestingAgentInstanceId: string;
  readonly scope: CrossProjectScope;
  readonly allowedMessageKinds: ReadonlyArray<CrossProjectMessageKind>;
  readonly purpose: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly revision: number;
  readonly isRevoked: boolean;
  /** 恒为 true：本卡不提供跨项目写入授权升级。 */
  readonly isReadOnly: true;
  /** 恒为 false：不可再转授权。 */
  readonly canBeRedelegated: false;
}

/** 授权给出者。 */
export type CrossProjectGrantor =
  | { readonly kind: "authenticated-user"; readonly userId: string }
  | {
      readonly kind: "target-project-main-agent";
      readonly agentInstanceId: string;
      readonly projectIdentifier: string;
    };

/** 授权签发结果。 */
export type CrossProjectAuthorizationOutcome =
  | { readonly kind: "granted"; readonly authorization: CrossProjectAuthorization }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "self-approval-forbidden"
        | "grantor-not-target-project"
        | "missing-purpose"
        | "missing-scope"
        | "missing-message-kinds"
        | "invalid-validity-window"
        | "write-scope-forbidden";
      readonly reason: string;
    };

/** 签发跨项目只读授权。 */
export function issueCrossProjectAuthorization(input: {
  readonly authorizationIdentifier: string;
  readonly sourceProjectIdentifier: string;
  readonly targetProjectIdentifier: string;
  readonly requestingAgentInstanceId: string;
  readonly grantor: CrossProjectGrantor;
  readonly scope: CrossProjectScope | null;
  readonly allowedMessageKinds: ReadonlyArray<string>;
  readonly purpose: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly revision: number;
}): CrossProjectAuthorizationOutcome {
  // 请求方不能自批（含"目标项目主 Agent 恰好就是请求者"的情况）
  if (
    input.grantor.kind === "target-project-main-agent" &&
    input.grantor.agentInstanceId === input.requestingAgentInstanceId
  ) {
    return {
      kind: "rejected",
      reasonCode: "self-approval-forbidden",
      reason: "请求方不能自批目标项目授权：必须由目标项目的**另一位**有权主 Agent 或认证用户批准。",
    };
  }
  if (
    input.grantor.kind === "target-project-main-agent" &&
    input.grantor.projectIdentifier !== input.targetProjectIdentifier
  ) {
    return {
      kind: "rejected",
      reasonCode: "grantor-not-target-project",
      reason:
        "批准者不属于目标项目（" +
        input.grantor.projectIdentifier +
        " ≠ " +
        input.targetProjectIdentifier +
        "）：模型自称项目主 Agent 不构成授权。",
    };
  }
  if (input.purpose.trim() === "") {
    return { kind: "rejected", reasonCode: "missing-purpose", reason: "授权必须写明用途。" };
  }
  if (input.scope === null) {
    return {
      kind: "rejected",
      reasonCode: "missing-scope",
      reason: "授权必须绑定具体对象或明确角色范围，不能是「整个项目」。",
    };
  }
  if (input.scope.kind === "role-range" && input.scope.roleIdentifiers.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "missing-scope",
      reason: "角色范围不能为空（空范围等于整项目）。",
    };
  }
  const requestedKinds = input.allowedMessageKinds.filter((kind) =>
    (CROSS_PROJECT_MESSAGE_KINDS as ReadonlyArray<string>).includes(kind),
  );
  if (input.allowedMessageKinds.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "missing-message-kinds",
      reason: "必须限定允许的消息类型（跨项目只有只读协作类型）。",
    };
  }
  // 只要出现写入类/未知类型，先报"写范围越界"，比"缺类型"更准确地说明问题
  if (requestedKinds.length !== input.allowedMessageKinds.length) {
    return {
      kind: "rejected",
      reasonCode: "write-scope-forbidden",
      reason: "跨项目授权只允许只读协作类型；写入类动作不在此卡范围内。",
    };
  }
  const issuedMilliseconds = Date.parse(input.issuedAtIso);
  const expiresMilliseconds = Date.parse(input.expiresAtIso);
  if (
    !Number.isFinite(issuedMilliseconds) ||
    !Number.isFinite(expiresMilliseconds) ||
    expiresMilliseconds <= issuedMilliseconds
  ) {
    return {
      kind: "rejected",
      reasonCode: "invalid-validity-window",
      reason: "有效期必须晚于签发时间（跨项目授权必须有期限）。",
    };
  }

  return {
    kind: "granted",
    authorization: {
      authorizationIdentifier: input.authorizationIdentifier,
      sourceProjectIdentifier: input.sourceProjectIdentifier,
      targetProjectIdentifier: input.targetProjectIdentifier,
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      scope: input.scope,
      allowedMessageKinds: requestedKinds as ReadonlyArray<CrossProjectMessageKind>,
      purpose: input.purpose.trim(),
      issuedAtIso: input.issuedAtIso,
      expiresAtIso: input.expiresAtIso,
      revision: input.revision,
      isRevoked: false,
      isReadOnly: true,
      canBeRedelegated: false,
    },
  };
}

/** 版本化信封（跨项目必需字段）。 */
export interface CrossProjectEnvelope {
  readonly messageIdentifier: string;
  readonly idempotencyKey: string;
  readonly senderAgentInstanceId: string;
  readonly recipientAgentInstanceId: string;
  readonly sourceProjectIdentifier: string;
  readonly targetProjectIdentifier: string;
  readonly sourceSessionIdentifier: string | null;
  readonly targetSessionIdentifier: string | null;
  readonly missionIdentifier: string | null;
  readonly taskIdentifier: string | null;
  /** 关系（授权）revision：旧 revision 的消息必须拒绝。 */
  readonly authorizationRevision: number;
  readonly messageKind: CrossProjectMessageKind;
  readonly correlationIdentifier: string | null;
  readonly replyToMessageIdentifier: string | null;
  /** 意图动作；跨项目只允许只读动作。 */
  readonly intendedAction: "read" | CrossProjectWriteAction;
}

/** 目标个体生命周期状态。 */
export type CrossProjectTargetLifecycle = "active" | "recycled" | "unknown";

/** 投递判定结果。 */
export type CrossProjectDeliveryOutcome =
  | { readonly kind: "allowed"; readonly authorizationRevision: number }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "authorization-not-found"
        | "authorization-revoked"
        | "authorization-expired"
        | "authorization-revision-stale"
        | "wrong-source-project"
        | "wrong-target-project"
        | "sender-not-authorized-agent"
        | "role-scope-mismatch"
        | "message-kind-not-allowed"
        | "write-action-forbidden"
        | "receiver-unavailable"
        | "envelope-incomplete";
      readonly reason: string;
    };

/**
 * 投递前校验（入队与投递前共用）。
 *
 * 顺序：授权存在 → 撤销/过期 → revision → 项目匹配 → 发起者/范围 → 消息类型 → 写动作 → 接收者。
 */
export function evaluateCrossProjectDelivery(input: {
  readonly envelope: CrossProjectEnvelope;
  readonly authorization: CrossProjectAuthorization | null;
  readonly nowIso: string;
  readonly targetLifecycle?: CrossProjectTargetLifecycle;
  readonly targetRoleIdentifiers?: ReadonlyArray<string>;
}): CrossProjectDeliveryOutcome {
  const envelope = input.envelope;
  const missingFields = [
    envelope.messageIdentifier,
    envelope.idempotencyKey,
    envelope.senderAgentInstanceId,
    envelope.recipientAgentInstanceId,
    envelope.sourceProjectIdentifier,
    envelope.targetProjectIdentifier,
  ].some((field) => typeof field !== "string" || field.trim() === "");
  if (missingFields) {
    return {
      kind: "rejected",
      reasonCode: "envelope-incomplete",
      reason: "信封缺少必要地址字段：不允许用模型自由文本补齐地址。",
    };
  }

  if (input.authorization === null) {
    return {
      kind: "rejected",
      reasonCode: "authorization-not-found",
      reason: "没有目标项目给出的跨项目授权：跨项目连接必须按需申请。",
    };
  }
  const authorization = input.authorization;
  if (authorization.isRevoked) {
    return {
      kind: "rejected",
      reasonCode: "authorization-revoked",
      reason: "授权已撤销：在途旧消息不得落入新任务。",
    };
  }
  if (Date.parse(input.nowIso) >= Date.parse(authorization.expiresAtIso)) {
    return {
      kind: "rejected",
      reasonCode: "authorization-expired",
      reason: "授权已过期（有效期 " + authorization.expiresAtIso + "）。",
    };
  }
  if (envelope.authorizationRevision !== authorization.revision) {
    return {
      kind: "rejected",
      reasonCode: "authorization-revision-stale",
      reason:
        "消息按授权 revision " +
        String(envelope.authorizationRevision) +
        " 签发，当前为 " +
        String(authorization.revision) +
        "：旧 revision 必须拒绝。",
    };
  }
  if (envelope.sourceProjectIdentifier !== authorization.sourceProjectIdentifier) {
    return {
      kind: "rejected",
      reasonCode: "wrong-source-project",
      reason: "源项目与授权不符。",
    };
  }
  if (envelope.targetProjectIdentifier !== authorization.targetProjectIdentifier) {
    return {
      kind: "rejected",
      reasonCode: "wrong-target-project",
      reason: "目标项目与授权不符（不可再转授权到其他项目）。",
    };
  }
  if (envelope.senderAgentInstanceId !== authorization.requestingAgentInstanceId) {
    return {
      kind: "rejected",
      reasonCode: "sender-not-authorized-agent",
      reason: "发送者不是被授权的源项目 Agent。",
    };
  }
  if (authorization.scope.kind === "specific-agent") {
    if (envelope.recipientAgentInstanceId !== authorization.scope.agentInstanceId) {
      return {
        kind: "rejected",
        reasonCode: "role-scope-mismatch",
        reason: "接收者不在授权绑定的具体对象范围内。",
      };
    }
  } else {
    const targetRoles = input.targetRoleIdentifiers ?? [];
    const isInScope = targetRoles.some((role) => authorization.scope.kind === "role-range" && authorization.scope.roleIdentifiers.includes(role));
    if (!isInScope) {
      return {
        kind: "rejected",
        reasonCode: "role-scope-mismatch",
        reason: "接收者不在授权的角色范围内。",
      };
    }
  }
  if (!authorization.allowedMessageKinds.includes(envelope.messageKind)) {
    return {
      kind: "rejected",
      reasonCode: "message-kind-not-allowed",
      reason: "消息类型不在授权范围内（" + envelope.messageKind + "）。",
    };
  }
  if (envelope.intendedAction !== "read") {
    return {
      kind: "rejected",
      reasonCode: "write-action-forbidden",
      reason:
        "跨项目只允许只读动作（收到 " +
        envelope.intendedAction +
        "）：如需变更，请提交建议由目标项目自行处理。",
    };
  }
  const lifecycle = input.targetLifecycle ?? "active";
  if (lifecycle !== "active") {
    return {
      kind: "rejected",
      reasonCode: "receiver-unavailable",
      reason: "目标个体不可用（" + lifecycle + "）：不按同名对象回退，明确拒绝。",
    };
  }
  return { kind: "allowed", authorizationRevision: authorization.revision };
}

/** 建议采纳：目标项目自己建任务；通信批准不等于执行批准。 */
export interface SuggestionAdoptionPlan {
  readonly adoptedTaskIdentifier: string;
  readonly adoptedByAgentInstanceId: string;
  readonly targetProjectIdentifier: string;
  readonly sourceSuggestionReference: {
    readonly messageIdentifier: string;
    readonly sourceProjectIdentifier: string;
    readonly sourceAgentInstanceId: string;
    readonly authorizationIdentifier: string;
  };
  /** 恒 false：采纳计划不携带执行批准。 */
  readonly isExecutionApproved: false;
  readonly requiresTargetProjectAuthorization: true;
}

export function planSuggestionAdoption(input: {
  readonly messageIdentifier: string;
  readonly sourceProjectIdentifier: string;
  readonly sourceAgentInstanceId: string;
  readonly authorizationIdentifier: string;
  readonly targetProjectIdentifier: string;
  readonly adoptedByAgentInstanceId: string;
  readonly proposedTaskIdentifier: string;
}): SuggestionAdoptionPlan {
  return {
    adoptedTaskIdentifier: input.proposedTaskIdentifier,
    adoptedByAgentInstanceId: input.adoptedByAgentInstanceId,
    targetProjectIdentifier: input.targetProjectIdentifier,
    sourceSuggestionReference: {
      messageIdentifier: input.messageIdentifier,
      sourceProjectIdentifier: input.sourceProjectIdentifier,
      sourceAgentInstanceId: input.sourceAgentInstanceId,
      authorizationIdentifier: input.authorizationIdentifier,
    },
    isExecutionApproved: false,
    requiresTargetProjectAuthorization: true,
  };
}

/** 撤销授权（保留历史 revision，供在途消息对账）。 */
export function revokeCrossProjectAuthorization(
  authorization: CrossProjectAuthorization,
): CrossProjectAuthorization {
  return {
    ...authorization,
    isRevoked: true,
    revision: authorization.revision + 1,
  };
}


