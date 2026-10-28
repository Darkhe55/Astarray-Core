/**
 * SEC-02-04（2026-10-28）：**通用外发门禁**契约。
 *
 * 卡内要求：外发门禁绑定**来源项目、内容 revision、目标账户/设备、授权范围、规则版本**；
 * 检查**内容**与**最终导出元数据**；脱敏导致内容变化要**生成新 revision 并重走授权绑定**；
 * 未认证 / 扫描未完成 / 来源无权 / 设备解绑 **均阻断**；产出公共调用链清单与静态反例记录。
 *
 * 本模块是**纯判定**（不联网、不发消息、不写盘）：把"这次外发能不能出"变成可核对的结果，
 * 由调用方（未来的 REMOTE-01 投递、报告导出、插件外发）在真正发送前调用。
 *
 * 四条硬约束：
 * 1. **默认拒绝**：缺任一绑定字段 ⇒ 阻断（不补默认值）。
 * 2. **扫描必须完成且干净**：`incomplete`/`error`/`sensitive` 一律阻断（"没扫完"不是"安全"）。
 * 3. **脱敏 ≠ 原内容**：脱敏后内容哈希变化 ⇒ 旧授权绑定**失效**，必须带**新 revision**
 *    重新授权；不允许用旧批准发送新内容。
 * 4. **最终导出元数据必须与绑定一致**：内容哈希 / revision / 目标账户 / 目标设备任一不符即阻断。
 */
import { createHash } from "node:crypto";

import type { SensitiveScanResult } from "./sensitive-content-scan-contract.js";

export type OutboundBlockingReasonCode =
  | "not-authenticated"
  | "missing-source-project"
  | "missing-content-revision"
  | "missing-target-account"
  | "device-unbound"
  | "scan-not-clean"
  | "scan-incomplete"
  | "rule-version-mismatch"
  | "content-hash-mismatch"
  | "revision-mismatch"
  | "target-mismatch"
  | "reauthorization-required";

export interface OutboundAuthorizationBinding {
  /** 授权绑定的来源项目（必须与内容来源一致）。 */
  readonly sourceProjectIdentifier: string;
  /** 授权时批准的内容 revision 与哈希。 */
  readonly approvedContentRevision: number;
  readonly approvedContentHash: string;
  /** 授权范围（例如 `read-only-report`）；缺省不允许任意外发。 */
  readonly authorizationScope: string;
  /** 目标账户（必须与本次外发目标一致）。 */
  readonly targetAccountIdentifier: string;
  /** 目标设备（平台不提供设备标识时为 null，此时只能承诺账户级授权）。 */
  readonly targetDeviceIdentifier: string | null;
  /** 授权时使用的规则集版本。 */
  readonly ruleSetVersion: number;
}

export interface OutboundContentCandidate {
  readonly sourceProjectIdentifier: string;
  /** 本次要外发的内容 revision（脱敏后必须**重新**生成）。 */
  readonly contentRevision: number;
  readonly content: string;
  /** 扫描结果（必须是 clean；缺省不允许）。 */
  readonly scanResult: SensitiveScanResult | null;
  /** 脱敏是否改变了内容（改变 ⇒ 必须重新授权）。 */
  readonly didRedactionChangeContent: boolean;
  /** 脱敏前的内容哈希（用于证明"变了"）。 */
  readonly preRedactionContentHash: string | null;
  readonly authorization: OutboundAuthorizationBinding | null;
  readonly authenticatedUserId: string | null;
  readonly targetAccountIdentifier: string;
  readonly targetDeviceIdentifier: string | null;
  /** 最终导出元数据（真正写进导出头/信封的内容指纹）。 */
  readonly exportMetadata: {
    readonly contentHash: string;
    readonly contentRevision: number;
    readonly targetAccountIdentifier: string;
    readonly targetDeviceIdentifier: string | null;
  };
}

export type OutboundContentGateDecision =
  | {
      readonly isAllowed: true;
      readonly contentHash: string;
      readonly scannedRuleSetVersion: number;
    }
  | {
      readonly isAllowed: false;
      readonly reasonCodes: readonly OutboundBlockingReasonCode[];
      readonly detail: string;
      /** 当阻断原因是"需要重新授权"时，给出应批准的新 revision/哈希。 */
      readonly requiredReauthorization: {
        readonly contentRevision: number;
        readonly contentHash: string;
      } | null;
    };

/** SHA-256 内容哈希（外发绑定与导出元数据都用它）。 */
export function computeOutboundContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * 判定一次外发是否放行。
 *
 * 顺序：认证 → 绑定完整性 → 规则版本 → 扫描结论 → 脱敏/哈希一致性 → 导出元数据一致性。
 * 任一项不过都**不发送**；原因码逐条返回（不合并成一句"被拒绝"）。
 */
export function evaluateOutboundContentGate(
  candidate: OutboundContentCandidate,
): OutboundContentGateDecision {
  const reasonCodes: OutboundBlockingReasonCode[] = [];
  const details: string[] = [];
  const contentHash = computeOutboundContentHash(candidate.content);

  if (candidate.authenticatedUserId === null || candidate.authenticatedUserId.trim() === "") {
    reasonCodes.push("not-authenticated");
    details.push("外发必须绑定已认证用户（匿名请求一律阻断）");
  }
  if (candidate.sourceProjectIdentifier.trim() === "") {
    reasonCodes.push("missing-source-project");
    details.push("缺少来源项目标识");
  }
  if (!Number.isInteger(candidate.contentRevision) || candidate.contentRevision < 1) {
    reasonCodes.push("missing-content-revision");
    details.push("缺少有效的内容 revision");
  }
  if (candidate.targetAccountIdentifier.trim() === "") {
    reasonCodes.push("missing-target-account");
    details.push("缺少目标账户");
  }
  const authorization = candidate.authorization;
  if (authorization === null) {
    reasonCodes.push("reauthorization-required");
    details.push("没有授权绑定：外发必须先取得显式授权");
  } else {
    if (authorization.sourceProjectIdentifier !== candidate.sourceProjectIdentifier) {
      reasonCodes.push("target-mismatch");
      details.push(
        `授权来源项目 ${authorization.sourceProjectIdentifier} 与本次来源 ${candidate.sourceProjectIdentifier} 不一致`,
      );
    }
    if (authorization.authorizationScope.trim() === "") {
      reasonCodes.push("reauthorization-required");
      details.push("授权缺少范围");
    }
    if (authorization.targetAccountIdentifier !== candidate.targetAccountIdentifier) {
      reasonCodes.push("target-mismatch");
      details.push("授权目标账户与本次目标不一致");
    }
    if (
      authorization.targetDeviceIdentifier !== null &&
      candidate.targetDeviceIdentifier !== authorization.targetDeviceIdentifier
    ) {
      reasonCodes.push("device-unbound");
      details.push("授权绑定的是另一台设备（或本次未提供设备标识）");
    }
  }

  const scanResult = candidate.scanResult;
  if (scanResult === null) {
    reasonCodes.push("scan-not-clean");
    details.push("缺少扫描结果：未扫描的内容不得外发");
  } else {
    if (scanResult.outcome === "incomplete") {
      reasonCodes.push("scan-incomplete");
      details.push(`扫描未完成：${scanResult.limitReason ?? "未知原因"}`);
    } else if (scanResult.outcome === "error") {
      reasonCodes.push("scan-incomplete");
      details.push(`扫描失败：${scanResult.limitReason ?? "未知原因"}`);
    } else if (scanResult.outcome === "sensitive") {
      reasonCodes.push("scan-not-clean");
      details.push(
        `内容命中敏感规则：${scanResult.matchedRuleIdentifiers.join(", ")}`,
      );
    }
    if (authorization !== null && scanResult.ruleSetVersion !== authorization.ruleSetVersion) {
      reasonCodes.push("rule-version-mismatch");
      details.push(
        `规则版本变化（授权 ${authorization.ruleSetVersion}，本次 ${scanResult.ruleSetVersion}）：需重新授权`,
      );
    }
  }

  /**
   * 脱敏/内容一致性：脱敏改变内容 ⇒ **旧批准失效**，必须以新 revision + 新哈希重新授权。
   */
  if (candidate.didRedactionChangeContent) {
    if (
      candidate.preRedactionContentHash === null ||
      candidate.preRedactionContentHash === contentHash
    ) {
      reasonCodes.push("content-hash-mismatch");
      details.push("声明发生了脱敏，但内容哈希未变化（记录不一致）");
    }
    if (authorization !== null) {
      if (
        authorization.approvedContentHash !== contentHash ||
        authorization.approvedContentRevision !== candidate.contentRevision
      ) {
        reasonCodes.push("reauthorization-required");
        details.push("脱敏后的内容与授权时批准的内容不同：必须以新 revision 重新授权");
      }
    }
  }

  if (
    authorization !== null &&
    (authorization.approvedContentHash !== contentHash ||
      authorization.approvedContentRevision !== candidate.contentRevision)
  ) {
    if (!reasonCodes.includes("reauthorization-required")) {
      reasonCodes.push("reauthorization-required");
      details.push("授权批准的内容哈希/revision 与本次外发内容不一致");
    }
  }

  /**
   * 最终导出元数据必须与"实际内容 + 授权"一致。
   */
  const exportMetadata = candidate.exportMetadata;
  if (exportMetadata.contentHash !== contentHash) {
    reasonCodes.push("content-hash-mismatch");
    details.push("导出元数据的内容哈希与实际内容不一致（检查 A 后导出 B）");
  }
  if (exportMetadata.contentRevision !== candidate.contentRevision) {
    reasonCodes.push("revision-mismatch");
    details.push("导出元数据的 revision 与本次内容 revision 不一致");
  }
  if (exportMetadata.targetAccountIdentifier !== candidate.targetAccountIdentifier) {
    reasonCodes.push("target-mismatch");
    details.push("导出元数据的目标账户与本次目标不一致");
  }
  if (exportMetadata.targetDeviceIdentifier !== candidate.targetDeviceIdentifier) {
    reasonCodes.push("device-unbound");
    details.push("导出元数据的目标设备与本次目标不一致");
  }

  const uniqueReasonCodes = [...new Set(reasonCodes)];
  if (uniqueReasonCodes.length > 0) {
    return {
      isAllowed: false,
      reasonCodes: uniqueReasonCodes,
      detail: details.join("；"),
      requiredReauthorization:
        uniqueReasonCodes.includes("reauthorization-required") ||
        uniqueReasonCodes.includes("rule-version-mismatch") ||
        uniqueReasonCodes.includes("content-hash-mismatch")
          ? { contentRevision: candidate.contentRevision, contentHash }
          : null,
    };
  }
  return {
    isAllowed: true,
    contentHash,
    scannedRuleSetVersion: scanResult?.ruleSetVersion ?? 0,
  };
}
