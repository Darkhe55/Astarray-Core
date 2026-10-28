/**
 * REMOTE-01-02（2026-10-28）：**远程主体绑定、权限范围与双步骤投递**。
 *
 * 卡内要求：
 * - 首次远程绑定必须由**认证用户单独确认**账户/设备，并返回**明确授权范围**
 *   （哪些项目、哪些记录类别、期限、发送目标）；未完成绑定的来信不产生导出/投递。
 * - **IM 来信不自动等于认证用户**：校验平台签名、时间戳/重放、账户绑定、设备可识别能力；
 *   平台不提供设备标识时只能承诺**账户/聊天级**授权。
 * - 设备请求在**有效预授权范围**内可直接得到记录（不要求回电脑重复批准）；
 *   越范围时在已有可信通道发**独立短授权请求**，不能自批、不能凭相同昵称扩权。
 * - 拆 `prepareEvidenceExport` 与 `deliverEvidenceExport`：秘书模型只提案，
 *   **可信本地控制面**渲染/发出。
 * - 新能力只加窄范围允许项，**不改**任意文件读取/桌面抓屏/通用 HTTP。
 *
 * 本模块是本地控制面服务：不做网络 I/O（投递经注入端口），不读模型上下文。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";
import type { EvidenceSnapshot, EvidenceSnapshotRequest } from "./remote-evidence-snapshot.js";
import { attemptRemoteDelivery } from "./remote-delivery-outbox.js";
import type {
  RemoteDeliveryOutbox,
  RemoteDeliveryTransportPort,
} from "./remote-delivery-outbox.js";

/** 允许导出的记录类别（窄范围；不包含"任意历史"）。 */
export type RemoteExportRecordKind =
  | "run-summary"
  | "task-status"
  | "tool-activity"
  | "artifact-registration"
  | "review-conclusion";

export interface RemoteIdentityBinding {
  readonly bindingIdentifier: string;
  readonly platformIdentifier: string;
  readonly accountIdentifier: string;
  /** 平台不提供设备标识时为 null（只能承诺账户/聊天级授权）。 */
  readonly deviceIdentifier: string | null;
  /** 完成单独确认的认证用户（不是昵称、不是会话 id）。 */
  readonly authenticatedUserId: string;
  readonly authorizedProjectIdentifiers: readonly string[];
  readonly authorizedRecordKinds: readonly RemoteExportRecordKind[];
  /** 授权 revision：授权范围变化即递增（投递 operation 绑定它，旧授权不得复用）。 */
  readonly authorizationRevision: number;
  readonly expiresAtIso: string;
  readonly createdAtIso: string;
  /** 撤销时间；非 null 即不可再用。 */
  readonly revokedAtIso: string | null;
}

export interface RemoteIdentityBindingDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly bindings: readonly RemoteIdentityBinding[];
}

export class RemoteIdentityBindingStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "remote-identity");
    this.filePath = path.join(directory, "bindings.json");
    this.backupFilePath = path.join(directory, "bindings.json.bak");
  }

  async read(): Promise<RemoteIdentityBindingDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, revision: 0, bindings: [] };
    }
    const content = readResult.content as Partial<RemoteIdentityBindingDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.bindings)
    ) {
      return { schemaVersion: 1, revision: 0, bindings: [] };
    }
    return {
      schemaVersion: 1,
      revision: typeof content.revision === "number" ? content.revision : 0,
      bindings: content.bindings,
    };
  }

  async upsert(binding: RemoteIdentityBinding): Promise<void> {
    await this.lock.runExclusive(async () => {
      const document = await this.read();
      const existingIndex = document.bindings.findIndex(
        (candidate) => candidate.bindingIdentifier === binding.bindingIdentifier,
      );
      const bindings =
        existingIndex === -1
          ? [...document.bindings, binding]
          : document.bindings.map((candidate, index) =>
              index === existingIndex ? binding : candidate,
            );
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: document.revision + 1,
        bindings,
      } satisfies RemoteIdentityBindingDocument);
    });
  }

  async findByIdentifier(
    bindingIdentifier: string,
  ): Promise<RemoteIdentityBinding | null> {
    const document = await this.read();
    return (
      document.bindings.find(
        (binding) => binding.bindingIdentifier === bindingIdentifier,
      ) ?? null
    );
  }
}

/** 入站 IM 消息的核验输入（平台能力如实传入，不假装有设备标识）。 */
export interface RemoteInboundMessageVerificationInput {
  readonly platformIdentifier: string;
  readonly platformSignatureValid: boolean;
  readonly platformTimestampIso: string;
  readonly receivedAtIso: string;
  readonly messageIdentifier: string;
  /** 已经处理过的消息标识（重放防护）。 */
  readonly seenMessageIdentifiers: readonly string[];
  readonly accountIdentifier: string;
  readonly deviceIdentifier: string | null;
  readonly maximumClockSkewSeconds?: number;
}

export type RemoteInboundMessageVerification =
  | {
      readonly isVerified: true;
      readonly bindingIdentifier: string;
      readonly authenticationLevel: "account-and-device" | "account-only";
    }
  | {
      readonly isVerified: false;
      readonly reasonCode:
        | "signature-invalid"
        | "timestamp-invalid"
        | "replayed-message"
        | "account-not-bound"
        | "device-mismatch"
        | "binding-expired-or-revoked"
        | "no-active-binding";
      readonly detail: string;
    };

/**
 * 核验一条入站消息**是否可作为某个已绑定用户的请求**。
 *
 * 明确不做的事：不把昵称/显示名当身份；不在签名失败时"降级为可信"；
 * 不接受已处理过的消息标识（重放）。
 */
export async function verifyRemoteInboundMessage(input: {
  readonly bindingStore: RemoteIdentityBindingStore;
  readonly message: RemoteInboundMessageVerificationInput;
  readonly nowIso: string;
}): Promise<RemoteInboundMessageVerification> {
  const message = input.message;
  if (!message.platformSignatureValid) {
    return {
      isVerified: false,
      reasonCode: "signature-invalid",
      detail: "平台签名无效：不能把该消息当成认证用户的请求。",
    };
  }
  if (message.seenMessageIdentifiers.includes(message.messageIdentifier)) {
    return {
      isVerified: false,
      reasonCode: "replayed-message",
      detail: "消息标识已处理过（重放拒绝）。",
    };
  }
  const timestampMilliseconds = Date.parse(message.platformTimestampIso);
  const nowMilliseconds = Date.parse(input.nowIso);
  const maximumSkewSeconds = message.maximumClockSkewSeconds ?? 300;
  if (
    Number.isNaN(timestampMilliseconds) ||
    Number.isNaN(nowMilliseconds) ||
    Math.abs(nowMilliseconds - timestampMilliseconds) > maximumSkewSeconds * 1000
  ) {
    return {
      isVerified: false,
      reasonCode: "timestamp-invalid",
      detail: `平台时间戳超出允许偏移（${maximumSkewSeconds}s）。`,
    };
  }
  const document = await input.bindingStore.read();
  const candidateBindings = document.bindings.filter(
    (binding) =>
      binding.platformIdentifier === message.platformIdentifier &&
      binding.accountIdentifier === message.accountIdentifier,
  );
  if (candidateBindings.length === 0) {
    return {
      isVerified: false,
      reasonCode: "account-not-bound",
      detail: "该平台账户尚未完成绑定（首次绑定必须由认证用户单独确认）。",
    };
  }
  const activeBindings = candidateBindings.filter(
    (binding) =>
      binding.revokedAtIso === null && Date.parse(binding.expiresAtIso) > nowMilliseconds,
  );
  if (activeBindings.length === 0) {
    return {
      isVerified: false,
      reasonCode: "binding-expired-or-revoked",
      detail: "绑定已过期或已撤销：必须重新完成确认。",
    };
  }
  const matchingDeviceBinding = activeBindings.find(
    (binding) => binding.deviceIdentifier === message.deviceIdentifier,
  );
  if (matchingDeviceBinding !== undefined) {
    return {
      isVerified: true,
      bindingIdentifier: matchingDeviceBinding.bindingIdentifier,
      authenticationLevel:
        matchingDeviceBinding.deviceIdentifier === null ? "account-only" : "account-and-device",
    };
  }
  const accountLevelBinding = activeBindings.find(
    (binding) => binding.deviceIdentifier === null,
  );
  if (accountLevelBinding !== undefined) {
    return {
      isVerified: true,
      bindingIdentifier: accountLevelBinding.bindingIdentifier,
      authenticationLevel: "account-only",
    };
  }
  return {
    isVerified: false,
    reasonCode: "device-mismatch",
    detail: "绑定只允许另一台设备：当前设备未获授权（不得凭相同昵称扩权）。",
  };
}

export interface RemoteExportScopeRequest {
  readonly projectIdentifier: string;
  readonly recordKinds: readonly RemoteExportRecordKind[];
  readonly targetAccountIdentifier: string;
  readonly targetDeviceIdentifier: string | null;
}

export type RemoteExportScopeDecision =
  | { readonly kind: "within-preauthorization" }
  | {
      readonly kind: "requires-independent-approval";
      readonly reasons: readonly string[];
    }
  | { readonly kind: "denied"; readonly reasons: readonly string[] };

/** 判定一次请求是否落在**已确认的预授权范围**内。 */
export function evaluateRemoteExportScope(input: {
  readonly binding: RemoteIdentityBinding;
  readonly request: RemoteExportScopeRequest;
  readonly nowIso: string;
}): RemoteExportScopeDecision {
  const reasons: string[] = [];
  const nowMilliseconds = Date.parse(input.nowIso);
  if (input.binding.revokedAtIso !== null) {
    return { kind: "denied", reasons: ["绑定已撤销"] };
  }
  if (
    Number.isNaN(nowMilliseconds) ||
    Date.parse(input.binding.expiresAtIso) <= nowMilliseconds
  ) {
    return { kind: "denied", reasons: ["绑定已过期"] };
  }
  if (
    !input.binding.authorizedProjectIdentifiers.includes(
      input.request.projectIdentifier,
    )
  ) {
    reasons.push(`项目 ${input.request.projectIdentifier} 不在授权范围`);
  }
  for (const recordKind of input.request.recordKinds) {
    if (!input.binding.authorizedRecordKinds.includes(recordKind)) {
      reasons.push(`记录类别 ${recordKind} 不在授权范围`);
    }
  }
  if (
    input.request.targetAccountIdentifier !== input.binding.accountIdentifier &&
    input.request.targetAccountIdentifier !== input.binding.authenticatedUserId
  ) {
    reasons.push("目标账户与绑定账户不一致");
  }
  if (
    input.binding.deviceIdentifier !== null &&
    input.request.targetDeviceIdentifier !== input.binding.deviceIdentifier
  ) {
    reasons.push("目标设备与绑定设备不一致");
  }
  if (reasons.length === 0) {
    return { kind: "within-preauthorization" };
  }
  /**
   * 越范围**不是**"自动拒绝"：需要在已有可信通道上发独立短授权请求。
   * 但**不能自批** —— 本函数只返回"需要独立批准"，不提供批准入口。
   */
  return { kind: "requires-independent-approval", reasons };
}

export interface PreparedRemoteEvidenceExport {
  readonly exportIdentifier: string;
  readonly bindingIdentifier: string;
  readonly snapshot: EvidenceSnapshot;
  readonly preparedAtIso: string;
  /** 渲染后的文本（可信本地控制面生成；秘书模型不参与渲染）。 */
  readonly renderedText: string;
}

export interface RemoteEvidenceDeliveryPort {
  /**
   * 真正发送。**必须幂等**（同一 exportIdentifier + contentHash 重复调用只发一次）——
   * 幂等 outbox 与 unknown 语义属检查点 03，本层只要求端口承诺。
   */
  send(input: {
    readonly exportIdentifier: string;
    readonly targetAccountIdentifier: string;
    readonly text: string;
    readonly contentHash: string;
  }): Promise<{ readonly status: "sent" | "already-sent" | "failed"; readonly detail?: string }>;
}

export class RemoteEvidenceExportService {
  constructor(
    private readonly options: {
      readonly bindingStore: RemoteIdentityBindingStore;
      /** 证据来源：通常是本地控制面的 `requestRunEvidence`。 */
      readonly evidenceProvider: (
        request: EvidenceSnapshotRequest,
      ) => Promise<EvidenceSnapshot>;
      readonly deliveryPort: RemoteEvidenceDeliveryPort;
      /**
       * REMOTE-01-03：幂等 outbox 与回执读取端口。
       * 两者都提供时，投递走 outbox（先读回执、unknown 语义、不自动换目标）；
       * 缺省则退回旧的"直接调 deliveryPort"路径（仅供旧调用方）。
       */
      readonly outbox?: RemoteDeliveryOutbox | null;
      readonly transport?: RemoteDeliveryTransportPort | null;
      readonly nowIso?: () => string;
    },
  ) {}

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  /**
   * 步骤一：**准备**（渲染 + 范围校验），不发送。
   *
   * 越范围/绑定无效直接拒绝；模型层拿不到任何发送能力（只有本服务有投递端口）。
   */
  async prepareEvidenceExport(input: {
    readonly bindingIdentifier: string;
    readonly request: EvidenceSnapshotRequest;
    readonly recordKinds: readonly RemoteExportRecordKind[];
    readonly targetAccountIdentifier: string;
    readonly targetDeviceIdentifier: string | null;
  }): Promise<PreparedRemoteEvidenceExport> {
    const binding = await this.options.bindingStore.findByIdentifier(
      input.bindingIdentifier,
    );
    if (binding === null) {
      throw new DomainError("mission-not-found", "远程绑定不存在：必须先完成首次确认。");
    }
    const scopeDecision = evaluateRemoteExportScope({
      binding,
      request: {
        projectIdentifier: input.request.projectIdentifier,
        recordKinds: input.recordKinds,
        targetAccountIdentifier: input.targetAccountIdentifier,
        targetDeviceIdentifier: input.targetDeviceIdentifier,
      },
      nowIso: this.now(),
    });
    if (scopeDecision.kind === "denied") {
      throw new DomainError(
        "task-sequence-permission-denied",
        `导出被拒绝：${scopeDecision.reasons.join("；")}`,
      );
    }
    if (scopeDecision.kind === "requires-independent-approval") {
      throw new DomainError(
        "tool-permission-denied",
        `超出预授权范围，需要独立短授权（不能自批）：${scopeDecision.reasons.join("；")}`,
      );
    }
    const snapshot = await this.options.evidenceProvider(input.request);
    const renderedText = renderEvidenceSnapshotAsPlainText(snapshot);
    return {
      exportIdentifier: `export:${snapshot.requestIdentifier}:${snapshot.snapshotRevision}`,
      bindingIdentifier: binding.bindingIdentifier,
      snapshot,
      preparedAtIso: this.now(),
      renderedText,
    };
  }

  /**
   * 步骤二：**投递**（只对已准备的导出；投递前再次核对绑定与范围）。
   *
   * 不重新渲染、不接受模型传入的文本 —— 发送内容必须来自 `prepareEvidenceExport`。
   */
  async deliverEvidenceExport(input: {
    readonly preparedExport: PreparedRemoteEvidenceExport;
    readonly targetAccountIdentifier: string;
    readonly targetDeviceIdentifier: string | null;
  }): Promise<
    | { readonly status: "sent" | "already-sent" }
    | { readonly status: "unknown"; readonly reason: string }
    | { readonly status: "requires-explicit-resend"; readonly reason: string }
    | { readonly status: "refused"; readonly reason: string }
  > {
    const binding = await this.options.bindingStore.findByIdentifier(
      input.preparedExport.bindingIdentifier,
    );
    if (binding === null) {
      return { status: "refused", reason: "绑定已不存在" };
    }
    const scopeDecision = evaluateRemoteExportScope({
      binding,
      request: {
        projectIdentifier: input.preparedExport.snapshot.projectIdentifier,
        recordKinds: [
          ...new Set(
            input.preparedExport.snapshot.entries
              .map((entry) => mapSourceKindToRecordKind(entry.sourceKind))
              .filter((kind): kind is RemoteExportRecordKind => kind !== null),
          ),
        ],
        targetAccountIdentifier: input.targetAccountIdentifier,
        targetDeviceIdentifier: input.targetDeviceIdentifier,
      },
      nowIso: this.now(),
    });
    if (scopeDecision.kind !== "within-preauthorization") {
      return {
        status: "refused",
        reason:
          scopeDecision.kind === "denied"
            ? scopeDecision.reasons.join("；")
            : `投递时发现超出预授权：${scopeDecision.reasons.join("；")}`,
      };
    }
    /**
     * REMOTE-01-03：装配了 outbox + 回执端口时，走幂等投递路径
     * （先读回执、unknown 语义、目标不可变）；否则保留旧的直接投递路径。
     */
    const outbox = this.options.outbox ?? null;
    const transport = this.options.transport ?? null;
    if (outbox !== null && transport !== null) {
      const nowIso = this.now();
      await outbox.enqueue({
        operationIdentifier: input.preparedExport.exportIdentifier,
        interactionRevision: input.preparedExport.snapshot.snapshotRevision,
        exportIdentifier: input.preparedExport.exportIdentifier,
        bindingIdentifier: binding.bindingIdentifier,
        targetAccountIdentifier: input.targetAccountIdentifier,
        targetDeviceIdentifier: input.targetDeviceIdentifier,
        contentHash: input.preparedExport.snapshot.contentHash,
        authorizationRevision: binding.authorizationRevision,
        recordKindCount: input.preparedExport.snapshot.entries.length,
        createdAtIso: nowIso,
      });
      const attemptOutcome = await attemptRemoteDelivery({
        outbox,
        transport,
        operationIdentifier: input.preparedExport.exportIdentifier,
        text: input.preparedExport.renderedText,
        nowIso,
      });
      switch (attemptOutcome.kind) {
        case "sent":
          return { status: "sent" };
        case "already-sent":
          return { status: "already-sent" };
        case "unknown":
          return { status: "unknown", reason: attemptOutcome.reason };
        case "requires-explicit-resend":
          return {
            status: "requires-explicit-resend",
            reason: attemptOutcome.reason,
          };
        case "refused":
          return { status: "refused", reason: attemptOutcome.reason };
      }
    }
    const sendResult = await this.options.deliveryPort.send({
      exportIdentifier: input.preparedExport.exportIdentifier,
      targetAccountIdentifier: input.targetAccountIdentifier,
      text: input.preparedExport.renderedText,
      contentHash: input.preparedExport.snapshot.contentHash,
    });
    if (sendResult.status === "failed") {
      return {
        status: "refused",
        reason: `投递端口失败：${sendResult.detail ?? "未知原因"}`,
      };
    }
    return {
      status: sendResult.status === "already-sent" ? "already-sent" : "sent",
    };
  }}

/** 来源类别 → 导出记录类别（用于投递前的范围复核）。 */
export function mapSourceKindToRecordKind(
  sourceKind: EvidenceSnapshot["entries"][number]["sourceKind"],
): RemoteExportRecordKind | null {
  switch (sourceKind) {
    case "user-message":
      return "run-summary";
    case "tool-call":
    case "tool-result":
      return "tool-activity";
    case "artifact-registration":
      return "artifact-registration";
    case "review-conclusion":
      return "review-conclusion";
    case "unknown":
      return "task-status";
    case "model-claim":
      return null;
  }
}

/** 可信本地控制面渲染：纯文本、标注来源与截断/脱敏，不渲染模型自由文本。 */
export function renderEvidenceSnapshotAsPlainText(snapshot: EvidenceSnapshot): string {
  const lines: string[] = [
    `运行记录快照 ${snapshot.requestIdentifier}（revision ${snapshot.snapshotRevision}）`,
    `项目：${snapshot.projectIdentifier}`,
    `捕获时间：${snapshot.capturedAtIso}（最近记录：${snapshot.lastObservedAtIso}；非实时）`,
    "",
  ];
  for (const entry of snapshot.entries) {
    const flags = [
      entry.isTruncated ? "已截断" : null,
      entry.isRedacted ? "已脱敏" : null,
      entry.isSummaryDerived ? "摘要派生" : null,
    ].filter((flag): flag is string => flag !== null);
    lines.push(
      `[${entry.sourceKind}] ${entry.recordedAtIso} ${entry.recordReference}` +
        (flags.length > 0 ? `（${flags.join("、")}）` : ""),
    );
    lines.push(entry.excerptText);
    lines.push("");
  }
  if (snapshot.omissions.reasonCodes.length > 0) {
    lines.push(`遗漏说明：${snapshot.omissions.reasonCodes.join("、")}`);
  }
  return lines.join("\n");
}
