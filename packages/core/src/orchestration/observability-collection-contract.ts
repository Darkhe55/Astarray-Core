/**
 * OBS-01 PERF/DIAG 采集契约（2026-10-19 R37）。
 *
 * 用户 2026-10-19 决策（按推荐，已生效）：
 * 1. **默认 off**，需显式开启；
 * 2. 采样预算：**每进程 ≤1 样本/5s**、磁盘 **≤10MB 环形 / 24h 保留**；
 * 3. **只采本进程/本任务**（RSS、事件循环延迟、任务时长、队列深度），**不采 OS 级**指标；
 * 4. DIAG 事件**只复用** `DomainError` + `doctor`，不新增网络/磁盘探测；
 * 5. 只存**分类 + 指纹 + 脱敏摘要**，绝不存原始参数、原始错误文本、含用户名的路径；
 * 6. **完全本地，不外传**；CLI `--json` 只读可查；
 * 7. 告警可见面：CLI 可查 + UI 展示。
 *
 * 卡内约束（`docs/tasks/OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS.md` §2）：
 * "unknown 不记作零"、"路径/堆栈/Provider 错误文本同样检查，不能先写原始日志再只遮盖界面"、
 * "存储预算耗尽时先停可选详细采集并报告，不静默删除历史"、"普通观测故障不得阻塞业务"。
 *
 * ## 边界
 * 纯判定：不采样、不写盘、不上传、不调模型。
 */
import { createHash } from "node:crypto";

/** 默认采样参数（原型测量前先冻结为"轻量"默认）。 */
export const DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS = 5;
export const DEFAULT_PERF_STORAGE_BUDGET_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PERF_RETENTION_HOURS = 24;

/** 本进程内允许采集的指标（**不含 OS 级** CPU/磁盘/网络）。 */
export type PerfSampleField = "residentMemoryBytes" | "eventLoopDelayMs" | "taskDurationMs" | "queueDepth";

/** 一条采样（只允许白名单字段）。 */
export interface PerfSampleV1 {
  readonly schemaVersion: 1;
  readonly sampledAtIso: string;
  readonly processIdentifier: number;
  readonly agentInstanceIdentifier: string | null;
  readonly fields: Readonly<Partial<Record<PerfSampleField, number>>>;
  /** 采样被跳过/丢样的原因（不静默丢失）。 */
  readonly droppedSampleCount: number;
}

/** 采集启动判定。 */
export type PerfCollectionDecision =
  | { readonly kind: "sample"; readonly reason: string }
  | {
      readonly kind: "skip";
      readonly reasonCode:
        | "collection-disabled"
        | "interval-not-elapsed"
        | "storage-budget-exhausted"
        | "retention-expired";
      readonly reason: string;
    };

/**
 * 判定此刻能否采一条样本。
 *
 * 次序：**开关** → **存储预算**（耗尽 ⇒ 停可选采集并报告，不静默删历史）→ **采样间隔**。
 */
export function evaluatePerfCollection(input: {
  readonly isCollectionEnabled: boolean;
  readonly lastSampleAtIso: string | null;
  readonly nowIso: string;
  readonly storageBytesUsed: number;
  readonly storageBudgetBytes?: number;
  readonly minimumSampleIntervalSeconds?: number;
}): PerfCollectionDecision {
  if (!input.isCollectionEnabled) {
    return {
      kind: "skip",
      reasonCode: "collection-disabled",
      reason: "PERF 采集默认关闭：需显式开启（避免默认真实开销）。",
    };
  }
  const storageBudgetBytes = input.storageBudgetBytes ?? DEFAULT_PERF_STORAGE_BUDGET_BYTES;
  if (input.storageBytesUsed >= storageBudgetBytes) {
    return {
      kind: "skip",
      reasonCode: "storage-budget-exhausted",
      reason: `存储预算已用尽（${String(input.storageBytesUsed)}/${String(storageBudgetBytes)} B）：先停可选采集并报告，不静默删除历史。`,
    };
  }
  const intervalSeconds = input.minimumSampleIntervalSeconds ?? DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS;
  if (input.lastSampleAtIso !== null) {
    const lastSampleAt = Date.parse(input.lastSampleAtIso);
    const now = Date.parse(input.nowIso);
    if (!Number.isNaN(lastSampleAt) && !Number.isNaN(now)) {
      const elapsedSeconds = (now - lastSampleAt) / 1000;
      if (elapsedSeconds < intervalSeconds) {
        return {
          kind: "skip",
          reasonCode: "interval-not-elapsed",
          reason: `采样间隔未到（至少 ${String(intervalSeconds)}s）：避免高频采样拖慢业务。`,
        };
      }
    }
  }
  return { kind: "sample", reason: "已开启、预算充足、间隔已到。" };
}

/**
 * 校验并规范化一条采样：**未知字段/OS 级指标一律拒绝**（"unknown 不记作零"）。
 */
export function buildPerfSample(input: {
  readonly sampledAtIso: string;
  readonly processIdentifier: number;
  readonly agentInstanceIdentifier: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly droppedSampleCount?: number;
}): { readonly kind: "built"; readonly sample: PerfSampleV1 } | {
  readonly kind: "rejected";
  readonly reason: string;
} {
  const allowedFields: ReadonlyArray<PerfSampleField> = [
    "residentMemoryBytes",
    "eventLoopDelayMs",
    "taskDurationMs",
    "queueDepth",
  ];
  const invalidFieldNames = Object.keys(input.fields).filter(
    (fieldName) => !allowedFields.includes(fieldName as PerfSampleField),
  );
  if (invalidFieldNames.length > 0) {
    return {
      kind: "rejected",
      reason: `包含非白名单指标（OS 级/未支持一律不采）：${invalidFieldNames.join(", ")}`,
    };
  }
  const fields: Partial<Record<PerfSampleField, number>> = {};
  for (const fieldName of allowedFields) {
    const value = input.fields[fieldName];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return {
        kind: "rejected",
        reason: `指标 ${fieldName} 不是有限非负数：unknown 不记作零，直接拒绝该样本。`,
      };
    }
    fields[fieldName] = value;
  }
  return {
    kind: "built",
    sample: {
      schemaVersion: 1,
      sampledAtIso: input.sampledAtIso,
      processIdentifier: input.processIdentifier,
      agentInstanceIdentifier: input.agentInstanceIdentifier,
      fields,
      droppedSampleCount: input.droppedSampleCount ?? 0,
    },
  };
}

/** DIAG 事件来源（**只允许**复用既有错误定义与 doctor）。 */
export type DiagEventSourceKind = "domain-error" | "doctor" | "network-probe" | "disk-probe";

/** 诊断事件（只存分类 + 指纹 + 脱敏摘要）。 */
export interface DiagEventV1 {
  readonly schemaVersion: 1;
  readonly occurredAtIso: string;
  readonly sourceKind: "domain-error" | "doctor";
  readonly classification: string;
  readonly fingerprint: string;
  /** 脱敏摘要：**不含**原始参数、原始错误文本、含用户名的路径。 */
  readonly sanitizedSummary: string;
  readonly projectIdentifier: string | null;
  readonly agentInstanceIdentifier: string | null;
}

/** 敏感内容检查结果。 */
export interface DiagSanitizationCheck {
  readonly containsRawArguments: boolean;
  readonly containsHomeDirectoryPath: boolean;
  readonly containsCredentialLikeValue: boolean;
}

/**
 * 诊断事件接收判定。
 *
 * 拒绝：不支持的数据源（网络/磁盘探测）、含原始参数/用户目录/凭据样式值、
 * 摘要为空。**不静默降级为"存原始文本"**。
 */
export function evaluateDiagEventAcceptance(input: {
  readonly sourceKind: DiagEventSourceKind;
  readonly classification: string;
  readonly sanitization: DiagSanitizationCheck;
}): { readonly kind: "accepted"; readonly reason: string } | {
  readonly kind: "rejected";
  readonly reasonCode:
    | "unsupported-source"
    | "unsupported-probe"
    | "contains-raw-arguments"
    | "contains-home-directory-path"
    | "contains-credential-like-value"
    | "missing-classification";
  readonly reason: string;
} {
  if (input.sourceKind === "network-probe" || input.sourceKind === "disk-probe") {
    return {
      kind: "rejected",
      reasonCode: "unsupported-probe",
      reason: "卡内冻结：不新增网络/磁盘探测；DIAG 只复用 DomainError 与 doctor。",
    };
  }
  if (input.sourceKind !== "domain-error" && input.sourceKind !== "doctor") {
    return {
      kind: "rejected",
      reasonCode: "unsupported-source",
      reason: "不支持的数据源：DIAG 只接受 domain-error 与 doctor。",
    };
  }
  if (input.classification.trim() === "") {
    return {
      kind: "rejected",
      reasonCode: "missing-classification",
      reason: "缺少错误分类：无法聚合成「同类问题」（也不得把 unknown 记为某个类别）。",
    };
  }
  if (input.sanitization.containsRawArguments) {
    return {
      kind: "rejected",
      reasonCode: "contains-raw-arguments",
      reason: "含原始命令/工具参数：卡内明令不得保存完整命令参数。",
    };
  }
  if (input.sanitization.containsHomeDirectoryPath) {
    return {
      kind: "rejected",
      reasonCode: "contains-home-directory-path",
      reason: "含用户目录路径：可能泄露本机用户名，必须先脱敏。",
    };
  }
  if (input.sanitization.containsCredentialLikeValue) {
    return {
      kind: "rejected",
      reasonCode: "contains-credential-like-value",
      reason: "疑似凭据值：诊断事件绝不保存凭据。",
    };
  }
  return { kind: "accepted", reason: "来源受支持且摘要已脱敏。" };
}

/** 错误指纹：同类问题聚合（不依赖原始文本，避免"文本一变就分成新问题"）。 */
export function computeDiagFingerprint(input: {
  readonly sourceKind: "domain-error" | "doctor";
  readonly classification: string;
  readonly operationIdentifier: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([input.sourceKind, input.classification, input.operationIdentifier]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** 采集边界（可核对：不上传、不存原始参数、不采 OS 级）。 */
export function describeObservabilityBoundary(): {
  readonly isUploadEnabled: false;
  readonly storesRawArguments: false;
  readonly storesRawErrorText: false;
  readonly collectsOsLevelMetrics: false;
  readonly isLocalOnly: true;
  readonly samplesDefaultOff: true;
} {
  return {
    isUploadEnabled: false,
    storesRawArguments: false,
    storesRawErrorText: false,
    collectsOsLevelMetrics: false,
    isLocalOnly: true,
    samplesDefaultOff: true,
  };
}

/**
 * 观测故障**不得阻塞业务**：把采集失败映射为"降级并报告"，而不是抛给调用方。
 */
export function evaluateObservabilityFailure(input: {
  readonly failureKind: "write-failed" | "query-failed" | "sampling-failed";
}): { readonly blocksBusinessOperations: false; readonly reportAsDegraded: true; readonly reason: string } {
  return {
    blocksBusinessOperations: false,
    reportAsDegraded: true,
    reason:
      input.failureKind === "write-failed"
        ? "观测写入失败：降级并报告（丢样计数），不阻塞业务操作。"
        : input.failureKind === "query-failed"
          ? "观测查询失败：降级并报告，不阻塞业务操作。"
          : "采样失败：降级并报告，不阻塞业务操作。",
  };
}
