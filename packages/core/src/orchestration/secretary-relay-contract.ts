/**
 * SECRETARY-01-02（CLIENT-01，2026-10-18 R7）：秘书的**项目/汇总模式、报告附件与任务转交回执**契约。
 *
 * 卡内依据（`docs/tasks/CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS.md` §2）：
 * - 两种工作方式（**项目模式** / **汇总模式**）；模式切换**不复制历史、不启动重复任务、
 *   不改变项目归属**；
 * - 项目报告由控制面生成/选择**带来源、项目、revision、时间和哈希的最小附件/状态快照**；
 *   秘书不能直接读项目目录；
 * - 默认普通后台报告**只入档**，不唤醒模型；
 * - 任务转交只生成**带目标项目的提案**，路由带原消息 ID/幂等 ID/关联回执，
 *   显示**待转交/已接收/已派发/实际完成**，**不把秘书回复视为项目已执行**；
 * - **防同级互转循环**，必要时升级用户；**不得一条指令广播所有项目**；
 * - 项目离线/报告过期时显示**最后更新时间和未知状态**，不推测完成。
 *
 * ## 边界
 * 纯函数：不写盘、不读项目、不调模型、不发消息。只做**判定与规范化**。
 */
import { createHash } from "node:crypto";

/** 工作方式（卡内两种；首期不引入第三种）。 */
export type SecretaryWorkingMode = "project" | "summary";

/**
 * 模式切换的**隔离断言**。
 *
 * 卡内要求切换「不复制历史、不启动重复任务、不改变项目归属」——
 * 这三条是**恒假**的事实（不是可配置项），因此这里返回常量并可被测试钉住：
 * 谁把其中一条改成 true，就是违反契约。
 */
export const SECRETARY_MODE_SWITCH_ISOLATION = {
  copiesHistory: false,
  startsDuplicateTasks: false,
  changesProjectOwnership: false,
} as const;

/** 报告附件（最小快照；**不含**项目正文）。 */
export interface SecretaryReportAttachmentV1 {
  readonly schemaVersion: 1;
  readonly projectIdentifier: string;
  /** 来源标识（例如 `main-agent-report`、`mission-summary`），**不可为空**。 */
  readonly sourceIdentifier: string;
  readonly projectRevision: number;
  readonly generatedAtIso: string;
  /** 内容哈希（sha256 hex）；用于证明"看的是这一版"。 */
  readonly contentHash: string;
  /** `null` = 不过期（不推荐，但允许显式给出）。 */
  readonly expiresAtIso: string | null;
  /** 首期恒为最小附件：**不含**项目目录正文。 */
  readonly isMinimal: true;
  /** 附件指纹（由上面字段规范化确定）。 */
  readonly attachmentFingerprint: string;
}

export type BuildReportAttachmentOutcome =
  | { readonly kind: "built"; readonly attachment: SecretaryReportAttachmentV1 }
  | { readonly kind: "rejected"; readonly reason: string };

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isNonBlank(value: string): boolean {
  return value.trim() !== "";
}

function isIsoDateTime(value: string): boolean {
  return ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** 附件指纹：字段顺序固定 ⇒ 同内容同指纹，revision/hash 变则指纹变。 */
function computeAttachmentFingerprint(input: {
  readonly projectIdentifier: string;
  readonly sourceIdentifier: string;
  readonly projectRevision: number;
  readonly generatedAtIso: string;
  readonly contentHash: string;
  readonly expiresAtIso: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.projectIdentifier,
        input.sourceIdentifier,
        input.projectRevision,
        input.generatedAtIso,
        input.contentHash,
        input.expiresAtIso,
      ]),
    )
    .digest("hex");
}

/**
 * 生成**最小报告附件**。
 *
 * 缺任何一项（项目/来源/revision/时间/哈希）⇒ `rejected`（不生成"看着有值其实是空"的附件）。
 */
export function buildSecretaryReportAttachment(input: {
  readonly projectIdentifier: string;
  readonly sourceIdentifier: string;
  readonly projectRevision: number;
  readonly generatedAtIso: string;
  readonly contentHash: string;
  readonly expiresAtIso?: string | null;
}): BuildReportAttachmentOutcome {
  if (!isNonBlank(input.projectIdentifier)) {
    return { kind: "rejected", reason: "缺少项目标识：无来源的附件不得进入汇总。" };
  }
  if (!isNonBlank(input.sourceIdentifier)) {
    return { kind: "rejected", reason: "缺少来源标识：报告必须可追溯。" };
  }
  if (!Number.isInteger(input.projectRevision) || input.projectRevision < 1) {
    return { kind: "rejected", reason: "缺少有效项目 revision：无法证明对应版本。" };
  }
  if (!isIsoDateTime(input.generatedAtIso)) {
    return { kind: "rejected", reason: "生成时间不是合法 ISO 时间戳。" };
  }
  if (!/^[0-9a-f]{16,64}$/.test(input.contentHash)) {
    return { kind: "rejected", reason: "内容哈希缺失或格式不符（需 16–64 位十六进制）。" };
  }
  const expiresAtIso = input.expiresAtIso ?? null;
  if (expiresAtIso !== null && !isIsoDateTime(expiresAtIso)) {
    return { kind: "rejected", reason: "过期时间不是合法 ISO 时间戳。" };
  }

  const attachmentFingerprint = computeAttachmentFingerprint({
    projectIdentifier: input.projectIdentifier,
    sourceIdentifier: input.sourceIdentifier,
    projectRevision: input.projectRevision,
    generatedAtIso: input.generatedAtIso,
    contentHash: input.contentHash,
    expiresAtIso,
  });

  return {
    kind: "built",
    attachment: {
      schemaVersion: 1,
      projectIdentifier: input.projectIdentifier,
      sourceIdentifier: input.sourceIdentifier,
      projectRevision: input.projectRevision,
      generatedAtIso: input.generatedAtIso,
      contentHash: input.contentHash,
      expiresAtIso,
      isMinimal: true,
      attachmentFingerprint,
    },
  };
}

/** 报告新鲜度（**不推测完成**）。 */
export type ReportFreshnessAssessment =
  | {
      readonly state: "fresh";
      readonly lastUpdatedIso: string;
      readonly reason: string;
    }
  | {
      readonly state: "stale";
      readonly lastUpdatedIso: string;
      readonly reason: string;
    }
  | {
      readonly state: "unknown-timestamp";
      readonly lastUpdatedIso: string | null;
      readonly reason: string;
    };

/**
 * 判定报告新鲜度。
 *
 * - 超过 `expiresAtIso`（或超过调用方给的 `maximumAgeMilliseconds`）⇒ `stale`，
 *   但仍**如实给出最后更新时间**（不显示成"已完成"）；
 * - 时间戳无法解析 ⇒ `unknown-timestamp`（不猜）。
 */
export function evaluateReportFreshness(input: {
  readonly attachment: SecretaryReportAttachmentV1;
  readonly nowIso: string;
  readonly maximumAgeMilliseconds?: number;
}): ReportFreshnessAssessment {
  const nowMilliseconds = Date.parse(input.nowIso);
  const generatedMilliseconds = Date.parse(input.attachment.generatedAtIso);
  if (Number.isNaN(generatedMilliseconds) || Number.isNaN(nowMilliseconds)) {
    return {
      state: "unknown-timestamp",
      lastUpdatedIso: Number.isNaN(generatedMilliseconds) ? null : input.attachment.generatedAtIso,
      reason: "时间戳无法解析：显示为未知状态，不推测完成。",
    };
  }

  const expirationMilliseconds =
    input.attachment.expiresAtIso === null
      ? null
      : Date.parse(input.attachment.expiresAtIso);
  const isExpired =
    expirationMilliseconds !== null &&
    !Number.isNaN(expirationMilliseconds) &&
    nowMilliseconds >= expirationMilliseconds;
  const isTooOld =
    input.maximumAgeMilliseconds !== undefined &&
    nowMilliseconds - generatedMilliseconds > input.maximumAgeMilliseconds;

  if (isExpired || isTooOld) {
    return {
      state: "stale",
      lastUpdatedIso: input.attachment.generatedAtIso,
      reason: `报告已过期/过旧（最后更新 ${input.attachment.generatedAtIso}）：显示最后更新时间与未知状态，不推测完成。`,
    };
  }

  return {
    state: "fresh",
    lastUpdatedIso: input.attachment.generatedAtIso,
    reason: "报告在有效期内。",
  };
}

/** 回执状态（**只能前进**）。 */
export type SecretaryRelayReceiptState =
  | "pending-transfer"
  | "accepted"
  | "dispatched"
  | "completed";

const RECEIPT_STATE_ORDER: Readonly<Record<SecretaryRelayReceiptState, number>> = {
  "pending-transfer": 0,
  accepted: 1,
  dispatched: 2,
  completed: 3,
};

/** 一条任务转交回执。 */
export interface SecretaryRelayReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptIdentifier: string;
  readonly idempotencyKey: string;
  /** 原始用户消息标识（**不得**被秘书回复替换）。 */
  readonly originalUserMessageIdentifier: string;
  readonly targetProjectIdentifier: string;
  readonly state: SecretaryRelayReceiptState;
  readonly updatedAtIso: string;
  /** 同级转达跳数（首期为 0；>0 表示经同级转达）。 */
  readonly hopCount: number;
}

/** 回执标识：同一 (幂等键, 目标项目) ⇒ 同一回执（多项目同名任务不串线）。 */
export function computeRelayReceiptIdentifier(input: {
  readonly idempotencyKey: string;
  readonly targetProjectIdentifier: string;
}): string {
  return (
    "secretary-relay:" +
    createHash("sha256")
      .update(JSON.stringify([input.idempotencyKey, input.targetProjectIdentifier]))
      .digest("hex")
      .slice(0, 24)
  );
}

export type RecordRelayDispatchOutcome =
  | { readonly kind: "dispatched"; readonly receipt: SecretaryRelayReceiptV1 }
  | {
      readonly kind: "idempotent-replay";
      readonly receipt: SecretaryRelayReceiptV1;
      readonly reason: string;
    }
  | { readonly kind: "conflict"; readonly reason: string };

/**
 * 登记一次**派发**（幂等）。
 *
 * - 同一 (幂等键, 目标项目) 已存在 ⇒ `idempotent-replay`（**不重复派发**）；
 * - 同一幂等键但目标项目不同 ⇒ `conflict`（不猜测用户意图）；
 * - 新建 ⇒ `pending-transfer` 起步（**不等于已执行**）。
 */
export function recordSecretaryRelayDispatch(input: {
  readonly existingReceipts: ReadonlyArray<SecretaryRelayReceiptV1>;
  readonly idempotencyKey: string;
  readonly originalUserMessageIdentifier: string;
  readonly targetProjectIdentifier: string;
  readonly dispatchedAtIso: string;
}): RecordRelayDispatchOutcome {
  const receiptIdentifier = computeRelayReceiptIdentifier({
    idempotencyKey: input.idempotencyKey,
    targetProjectIdentifier: input.targetProjectIdentifier,
  });

  const sameReceipt = input.existingReceipts.find(
    (receipt) => receipt.receiptIdentifier === receiptIdentifier,
  );
  if (sameReceipt !== undefined) {
    return {
      kind: "idempotent-replay",
      receipt: sameReceipt,
      reason: "同一幂等键与目标项目已登记：不重复派发。",
    };
  }

  const sameKeyDifferentTarget = input.existingReceipts.find(
    (receipt) => receipt.idempotencyKey === input.idempotencyKey,
  );
  if (sameKeyDifferentTarget !== undefined) {
    return {
      kind: "conflict",
      reason: "同一幂等键已指向另一个项目：不猜测用户意图，需人工确认。",
    };
  }

  return {
    kind: "dispatched",
    receipt: {
      schemaVersion: 1,
      receiptIdentifier,
      idempotencyKey: input.idempotencyKey,
      originalUserMessageIdentifier: input.originalUserMessageIdentifier,
      targetProjectIdentifier: input.targetProjectIdentifier,
      state: "pending-transfer",
      updatedAtIso: input.dispatchedAtIso,
      hopCount: 0,
    },
  };
}

/**
 * 推进回执状态：**只允许前进**。
 *
 * 卡内：回执要显示"待转交/已接收/已派发/实际完成"，且**不把秘书回复视为项目已执行**。
 * 因此倒退（例如 completed → dispatched）一律拒绝。
 */
export function advanceSecretaryRelayReceipt(input: {
  readonly receipt: SecretaryRelayReceiptV1;
  readonly nextState: SecretaryRelayReceiptState;
  readonly updatedAtIso: string;
}): { readonly kind: "advanced"; readonly receipt: SecretaryRelayReceiptV1 } | {
  readonly kind: "rejected";
  readonly reason: string;
} {
  const currentOrder = RECEIPT_STATE_ORDER[input.receipt.state];
  const nextOrder = RECEIPT_STATE_ORDER[input.nextState];
  if (nextOrder <= currentOrder) {
    return {
      kind: "rejected",
      reason: `回执状态只能前进（当前 ${input.receipt.state}，请求 ${input.nextState}）。`,
    };
  }
  return {
    kind: "advanced",
    receipt: {
      ...input.receipt,
      state: input.nextState,
      updatedAtIso: input.updatedAtIso,
    },
  };
}

/**
 * 同级转达有界：超过 `maximumHops` ⇒ 拒绝并**升级用户**（防同级互转循环）。
 *
 * 首期 `maximumHops` 建议 1（秘书自身不转达；同级之间最多一次）。
 */
export function evaluatePeerRelay(input: {
  readonly hopCount: number;
  readonly maximumHops: number;
}): {
  readonly isAllowed: boolean;
  readonly shouldEscalateToUser: boolean;
  readonly nextHopCount: number;
  readonly reason: string;
} {
  if (input.hopCount >= input.maximumHops) {
    return {
      isAllowed: false,
      shouldEscalateToUser: true,
      nextHopCount: input.hopCount,
      reason: `同级转达已达上限（${String(input.maximumHops)} 跳）：停止互转并升级用户裁决。`,
    };
  }
  return {
    isAllowed: true,
    shouldEscalateToUser: false,
    nextHopCount: input.hopCount + 1,
    reason: "在允许跳数内。",
  };
}

/**
 * 汇总列表的**任务行键**：必须包含项目标识。
 *
 * 卡内：「多项目同名任务不串线」⇒ 两个项目里同名的任务必须得到不同的键，
 * 否则汇总视图会把它们合并成一条。
 */
export function computeSecretaryTaskLineKey(input: {
  readonly projectIdentifier: string;
  readonly taskText: string;
  readonly taskIdentifier?: string | null;
}): string {
  return [
    "secretary-task-line",
    input.projectIdentifier,
    input.taskIdentifier ?? "",
    input.taskText.trim(),
  ].join(":");
}
