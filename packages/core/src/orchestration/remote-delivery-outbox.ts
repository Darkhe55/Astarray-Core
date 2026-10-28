/**
 * REMOTE-01-03（2026-10-28）：**幂等投递 outbox 与 unknown 语义**。
 *
 * 卡内要求：
 * - 每次投递使用**稳定 operation id + interaction revision**；重试时**先读回执**；
 * - 必填字段、格式、长度、内容 hash、目标账户/设备、授权 revision **不完整就不发送**；
 * - **没有明确回执一律 `unknown`**（不得把"发出去了"当成"已送达"）；
 * - 失败**不自动换目标**，不直接尝试其它账户、公开链接或邮件兜底。
 *
 * 设计要点：
 * - outbox 落盘（`<state>/remote-delivery/outbox.json`），写入走原子 JSON + 互斥；
 * - `enqueue` 以 `operationIdentifier` 为准幂等：同 id 同内容 ⇒ 返回既有记录（不重复入队）；
 *   同 id **不同**内容 ⇒ 拒绝（防止"换内容复用同一 operation"）；
 * - `attemptDelivery` 先 `readReceipt`：有明确回执 ⇒ 不重发；无回执 ⇒ 置 `unknown`，
 *   只有调用方**显式** `isResendAfterUnknown` 才允许再发（重复副作用由端口幂等键兜底）；
 * - 目标账户/设备一旦入队即不可改（改目标 = 拒绝，不做"自动换目标"）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export type RemoteDeliveryOperationState =
  | "pending"
  | "sending"
  | "sent"
  | "unknown"
  | "refused";

export interface RemoteDeliveryOperation {
  /** 稳定 operation id（服务端生成，重试不变）。 */
  readonly operationIdentifier: string;
  /** 交互 revision：同一请求的多次修订必须递增，不能混用。 */
  readonly interactionRevision: number;
  readonly exportIdentifier: string;
  readonly bindingIdentifier: string;
  readonly targetAccountIdentifier: string;
  readonly targetDeviceIdentifier: string | null;
  /** 内容哈希（`sha256:<hex>`），用于"发的是检查过的那份内容"。 */
  readonly contentHash: string;
  /** 授权绑定 revision（授权变化后旧 operation 不得复用）。 */
  readonly authorizationRevision: number;
  readonly recordKindCount: number;
  readonly createdAtIso: string;
  readonly state: RemoteDeliveryOperationState;
  /** 平台回执标识（有值才代表"已送达"）。 */
  readonly platformReceiptIdentifier: string | null;
  readonly stateChangedAtIso: string;
  readonly lastRefusalReason: string | null;
}

export interface RemoteDeliveryOutboxDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly operations: readonly RemoteDeliveryOperation[];
}

/** 完整性校验结论：不完整就**不发送**。 */
export interface RemoteDeliveryCompleteness {
  readonly isComplete: boolean;
  readonly reasons: readonly string[];
}

/** 必填项/格式/长度校验（纯函数；不读盘、不发网络）。 */
export function validateRemoteDeliveryOperation(input: {
  readonly operationIdentifier: string;
  readonly interactionRevision: number;
  readonly exportIdentifier: string;
  readonly bindingIdentifier: string;
  readonly targetAccountIdentifier: string;
  readonly targetDeviceIdentifier: string | null;
  readonly contentHash: string;
  readonly authorizationRevision: number;
}): RemoteDeliveryCompleteness {
  const reasons: string[] = [];
  if (input.operationIdentifier.trim() === "") {
    reasons.push("缺少 operationIdentifier");
  }
  if (!Number.isInteger(input.interactionRevision) || input.interactionRevision < 1) {
    reasons.push("interactionRevision 必须是 ≥1 的整数");
  }
  if (input.exportIdentifier.trim() === "") {
    reasons.push("缺少 exportIdentifier");
  }
  if (input.bindingIdentifier.trim() === "") {
    reasons.push("缺少 bindingIdentifier");
  }
  if (input.targetAccountIdentifier.trim() === "") {
    reasons.push("缺少目标账户");
  }
  if (input.targetAccountIdentifier.length > 256) {
    reasons.push("目标账户标识过长");
  }
  if (
    input.targetDeviceIdentifier !== null &&
    input.targetDeviceIdentifier.trim() === ""
  ) {
    reasons.push("设备标识为空字符串（应传 null 表示账户级授权）");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.contentHash)) {
    reasons.push(`内容 hash 格式非法（期望 sha256:<64 hex>）: ${input.contentHash}`);
  }
  if (
    !Number.isInteger(input.authorizationRevision) ||
    input.authorizationRevision < 1
  ) {
    reasons.push("缺少有效的授权 revision");
  }
  return { isComplete: reasons.length === 0, reasons };
}

export interface RemoteDeliveryReceipt {
  readonly kind: "acknowledged" | "not-delivered" | "unknown";
  readonly platformReceiptIdentifier: string | null;
  readonly observedAtIso: string;
}

/** 投递端口：发送与**读回执**分离；端口必须按 operation id 幂等。 */
export interface RemoteDeliveryTransportPort {
  send(input: {
    readonly operationIdentifier: string;
    readonly targetAccountIdentifier: string;
    readonly targetDeviceIdentifier: string | null;
    readonly text: string;
    readonly contentHash: string;
  }): Promise<{ readonly status: "accepted" | "rejected"; readonly detail?: string }>;
  readReceipt(input: {
    readonly operationIdentifier: string;
  }): Promise<RemoteDeliveryReceipt | null>;
}

export class RemoteDeliveryOutbox {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "remote-delivery");
    this.filePath = path.join(directory, "outbox.json");
    this.backupFilePath = path.join(directory, "outbox.json.bak");
  }

  async readDocument(): Promise<RemoteDeliveryOutboxDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, revision: 0, operations: [] };
    }
    const content = readResult.content as Partial<RemoteDeliveryOutboxDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.operations)
    ) {
      return { schemaVersion: 1, revision: 0, operations: [] };
    }
    return {
      schemaVersion: 1,
      revision: typeof content.revision === "number" ? content.revision : 0,
      operations: content.operations,
    };
  }

  /** 入队：同 id 幂等；同 id 不同内容 ⇒ 拒绝（不换内容复用同一 operation）。 */
  async enqueue(
    operation: Omit<
      RemoteDeliveryOperation,
      "state" | "platformReceiptIdentifier" | "stateChangedAtIso" | "lastRefusalReason"
    >,
  ): Promise<{ readonly wasEnqueued: boolean; readonly operation: RemoteDeliveryOperation }> {
    const completeness = validateRemoteDeliveryOperation(operation);
    if (!completeness.isComplete) {
      throw new DomainError(
        "invalid-task-chain",
        `投递 operation 不完整（不发送）：${completeness.reasons.join("；")}`,
      );
    }
    return await this.lock.runExclusive(async () => {
      const document = await this.readDocument();
      const existing = document.operations.find(
        (candidate) =>
          candidate.operationIdentifier === operation.operationIdentifier,
      );
      if (existing !== undefined) {
        const isSameContent =
          existing.contentHash === operation.contentHash &&
          existing.interactionRevision === operation.interactionRevision &&
          existing.targetAccountIdentifier === operation.targetAccountIdentifier &&
          existing.targetDeviceIdentifier === operation.targetDeviceIdentifier;
        if (!isSameContent) {
          throw new DomainError(
            "invalid-task-chain",
            "同一 operationIdentifier 不能复用于不同内容/目标/修订（拒绝静默改发）。",
          );
        }
        return { wasEnqueued: false, operation: existing };
      }
      const enqueued: RemoteDeliveryOperation = {
        ...operation,
        state: "pending",
        platformReceiptIdentifier: null,
        stateChangedAtIso: operation.createdAtIso,
        lastRefusalReason: null,
      };
      await this.writeDocument({
        schemaVersion: 1,
        revision: document.revision + 1,
        operations: [...document.operations, enqueued],
      });
      return { wasEnqueued: true, operation: enqueued };
    });
  }

  async updateState(input: {
    readonly operationIdentifier: string;
    readonly state: RemoteDeliveryOperationState;
    readonly platformReceiptIdentifier?: string | null;
    readonly lastRefusalReason?: string | null;
    readonly observedAtIso: string;
  }): Promise<RemoteDeliveryOperation> {
    return await this.lock.runExclusive(async () => {
      const document = await this.readDocument();
      let updated: RemoteDeliveryOperation | null = null;
      const operations = document.operations.map((operation) => {
        if (operation.operationIdentifier !== input.operationIdentifier) {
          return operation;
        }
        updated = {
          ...operation,
          state: input.state,
          platformReceiptIdentifier:
            input.platformReceiptIdentifier ?? operation.platformReceiptIdentifier,
          lastRefusalReason: input.lastRefusalReason ?? null,
          stateChangedAtIso: input.observedAtIso,
        };
        return updated;
      });
      if (updated === null) {
        throw new DomainError(
          "mission-not-found",
          `投递 operation 不存在: ${input.operationIdentifier}`,
        );
      }
      await this.writeDocument({
        schemaVersion: 1,
        revision: document.revision + 1,
        operations,
      });
      return updated;
    });
  }

  async find(operationIdentifier: string): Promise<RemoteDeliveryOperation | null> {
    const document = await this.readDocument();
    return (
      document.operations.find(
        (operation) => operation.operationIdentifier === operationIdentifier,
      ) ?? null
    );
  }

  private async writeDocument(document: RemoteDeliveryOutboxDocument): Promise<void> {
    await writeAtomicJson(this.filePath, document);
  }
}

export type RemoteDeliveryAttemptOutcome =
  | { readonly kind: "sent"; readonly platformReceiptIdentifier: string | null }
  | { readonly kind: "already-sent"; readonly platformReceiptIdentifier: string | null }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "requires-explicit-resend"; readonly reason: string };

/**
 * 尝试投递一次。
 *
 * 顺序：读既有状态 → **先读回执** → 有明确回执 ⇒ 完成；无回执 ⇒ `unknown`；
 * `unknown` 状态下只有显式 `isResendAfterUnknown` 才重发。
 */
export async function attemptRemoteDelivery(input: {
  readonly outbox: RemoteDeliveryOutbox;
  readonly transport: RemoteDeliveryTransportPort;
  readonly operationIdentifier: string;
  readonly text: string;
  readonly nowIso: string;
  readonly isResendAfterUnknown?: boolean;
}): Promise<RemoteDeliveryAttemptOutcome> {
  const operation = await input.outbox.find(input.operationIdentifier);
  if (operation === null) {
    return { kind: "refused", reason: "operation 未入队（拒绝发送未校验的投递）" };
  }
  if (operation.state === "sent") {
    return {
      kind: "already-sent",
      platformReceiptIdentifier: operation.platformReceiptIdentifier,
    };
  }
  if (operation.state === "refused") {
    return {
      kind: "refused",
      reason: operation.lastRefusalReason ?? "operation 已被拒绝",
    };
  }
  const receipt = await input.transport.readReceipt({
    operationIdentifier: operation.operationIdentifier,
  });
  if (receipt !== null && receipt.kind === "acknowledged") {
    await input.outbox.updateState({
      operationIdentifier: operation.operationIdentifier,
      state: "sent",
      platformReceiptIdentifier: receipt.platformReceiptIdentifier,
      observedAtIso: input.nowIso,
    });
    return {
      kind: "already-sent",
      platformReceiptIdentifier: receipt.platformReceiptIdentifier,
    };
  }
  if (operation.state === "unknown" && input.isResendAfterUnknown !== true) {
    return {
      kind: "requires-explicit-resend",
      reason: "上次投递结果未知：必须先读回执或显式确认重发（不自动重试）。",
    };
  }
  await input.outbox.updateState({
    operationIdentifier: operation.operationIdentifier,
    state: "sending",
    observedAtIso: input.nowIso,
  });
  const sendResult = await input.transport.send({
    operationIdentifier: operation.operationIdentifier,
    targetAccountIdentifier: operation.targetAccountIdentifier,
    targetDeviceIdentifier: operation.targetDeviceIdentifier,
    text: input.text,
    contentHash: operation.contentHash,
  });
  if (sendResult.status === "rejected") {
    const updated = await input.outbox.updateState({
      operationIdentifier: operation.operationIdentifier,
      state: "refused",
      lastRefusalReason: sendResult.detail ?? "端口拒绝",
      observedAtIso: input.nowIso,
    });
    return {
      kind: "refused",
      reason: updated.lastRefusalReason ?? "端口拒绝",
    };
  }
  /**
   * 端口"已受理"**不是**送达：必须再读一次回执；拿不到明确回执 ⇒ `unknown`。
   */
  const receiptAfterSend = await input.transport.readReceipt({
    operationIdentifier: operation.operationIdentifier,
  });
  if (
    receiptAfterSend !== null &&
    receiptAfterSend.kind === "acknowledged" &&
    receiptAfterSend.platformReceiptIdentifier !== null
  ) {
    await input.outbox.updateState({
      operationIdentifier: operation.operationIdentifier,
      state: "sent",
      platformReceiptIdentifier: receiptAfterSend.platformReceiptIdentifier,
      observedAtIso: input.nowIso,
    });
    return {
      kind: "sent",
      platformReceiptIdentifier: receiptAfterSend.platformReceiptIdentifier,
    };
  }
  await input.outbox.updateState({
    operationIdentifier: operation.operationIdentifier,
    state: "unknown",
    observedAtIso: input.nowIso,
  });
  return {
    kind: "unknown",
    reason: "平台未返回明确送达回执：结果记为 unknown，不当作已送达。",
  };
}

/**
 * 目标切换守卫：已入队 operation 的目标不可改（**不自动换目标**）。
 *
 * 需要换目标 ⇒ 新 operation（新 id、新授权 revision），由用户/控制面显式发起。
 */
export async function assertRemoteDeliveryTargetUnchanged(input: {
  readonly outbox: RemoteDeliveryOutbox;
  readonly operationIdentifier: string;
  readonly targetAccountIdentifier: string;
  readonly targetDeviceIdentifier: string | null;
}): Promise<void> {
  const operation = await input.outbox.find(input.operationIdentifier);
  if (operation === null) {
    throw new DomainError("mission-not-found", "投递 operation 不存在");
  }
  if (
    operation.targetAccountIdentifier !== input.targetAccountIdentifier ||
    operation.targetDeviceIdentifier !== input.targetDeviceIdentifier
  ) {
    throw new DomainError(
      "task-sequence-permission-denied",
      "投递目标与已入队 operation 不一致：拒绝自动换目标（需新 operation 与新授权）。",
    );
  }
}
