/**
 * RELOCATE-01 检查点 03：**结构化资源路径解析**（2026-10-18 第 15 轮）。
 *
 * 依据卡内 §4：
 * - 映射**绑定项目、设备和位置 revision**；
 * - 仅解析 **schema 明确声明的结构化资源路径**和受控历史链接 ——
 *   历史消息、日志、证据、源码、配置、任意命令字符串**不自动替换**；
 * - **拒绝循环、歧义和不明确的重叠规则**，不形成无限链；
 * - 保留**原请求路径**及实际解析路径/revision；
 * - 历史旧根被**另一项目**使用时，映射只在原项目上下文生效（不截获新项目访问）；
 * - 不能以字符串前缀判断包含关系（复用 `isPathInsideProjectRoot`）。
 *
 * 说明：**允许改写的资源种类由调用方（schema 所有者）传入**，本模块不自行发明种类。
 */

import { isPathInsideProjectRoot } from "./project-relocation-classification.js";

/** 一处位置映射（旧根 → 新根，绑定项目/设备/位置 revision）。 */
export interface ProjectLocationMapping {
  readonly projectIdentifier: string;
  readonly deviceIdentifier: string;
  /** 该映射生效的起点 revision（历史记录在该 revision 之后才属于新根）。 */
  readonly fromLocationRevision: number;
  readonly oldRootPath: string;
  readonly newRootPath: string;
}

/** 历史记录中的结构化资源引用。 */
export interface StructuredResourceReference {
  readonly resourceKind: string;
  readonly requestedPath: string;
  readonly owningProjectIdentifier: string;
  readonly owningDeviceIdentifier: string;
  readonly capturedLocationRevision: number;
}

/** 解析拒绝原因（稳定代码）。 */
export type StructuredResourceRejectionCode =
  | "unsupported-resource-kind"
  | "foreign-project"
  | "foreign-device"
  | "outside-old-root"
  | "ambiguous-mapping";

/** 解析结果。 */
export type StructuredResourceResolution =
  | {
      readonly kind: "resolved";
      /** 历史里保存的原始路径（脱敏由调用方负责）。 */
      readonly requestedPath: string;
      readonly resolvedPath: string;
      readonly appliedLocationRevision: number;
      readonly wasRewritten: boolean;
      readonly reason: string;
    }
  | {
      readonly kind: "unresolved";
      readonly rejectionCode: StructuredResourceRejectionCode;
      readonly reason: string;
    };

/**
 * 解析一条结构化资源引用。
 *
 * **fail-closed**：种类未声明、跨项目、跨设备、不在旧根之内、映射歧义 ⇒ 一律不解析（不改写）。
 */
export function resolveStructuredResourcePath(input: {
  readonly reference: StructuredResourceReference;
  /** 该**项目**当前已知的位置映射（调用方须已按项目/设备过滤）。 */
  readonly mappings: readonly ProjectLocationMapping[];
  /** schema **声明**允许改写的资源种类（空集合 ⇒ 什么都不改写）。 */
  readonly declaredStructuredResourceKinds: readonly string[];
}): StructuredResourceResolution {
  const { reference } = input;

  // ① 种类必须被 schema 声明（消息/日志/源码/命令串不在其中 ⇒ 永不改写）
  if (!input.declaredStructuredResourceKinds.includes(reference.resourceKind)) {
    return {
      kind: "unresolved",
      rejectionCode: "unsupported-resource-kind",
      reason: `资源种类 ${reference.resourceKind} 未被 schema 声明为结构化资源；不自动替换路径。`,
    };
  }

  // ② 只在本项目上下文生效（历史旧根被别的项目使用时，不截获其访问）
  const projectMappings = input.mappings.filter(
    (mapping) => mapping.projectIdentifier === reference.owningProjectIdentifier,
  );
  if (projectMappings.length === 0) {
    return {
      kind: "unresolved",
      rejectionCode: "foreign-project",
      reason: "该引用不属于任何本地登记的项目；跨项目引用不自动映射。",
    };
  }

  // ③ 设备必须一致（位置登记独立保存设备）
  const deviceMappings = projectMappings.filter(
    (mapping) => mapping.deviceIdentifier === reference.owningDeviceIdentifier,
  );
  if (deviceMappings.length === 0) {
    return {
      kind: "unresolved",
      rejectionCode: "foreign-device",
      reason: "引用记录于另一台设备；不同设备的路径语义不同，不自动映射。",
    };
  }

  // ④ 已在新根（revision 晚于映射起点）⇒ 原样解析，不改写
  const alreadyAtNewRoot = deviceMappings.some(
    (mapping) =>
      reference.capturedLocationRevision > mapping.fromLocationRevision &&
      isPathInsideProjectRoot({
        projectRootPath: mapping.newRootPath,
        candidatePath: reference.requestedPath,
      }),
  );
  if (alreadyAtNewRoot) {
    return {
      kind: "resolved",
      requestedPath: reference.requestedPath,
      resolvedPath: reference.requestedPath,
      appliedLocationRevision: reference.capturedLocationRevision,
      wasRewritten: false,
      reason: "该引用产生于映射之后，已指向新根；无需改写。",
    };
  }

  // ⑤ 找出"旧根包含该路径"的候选映射
  const matchedMappings = deviceMappings.filter(
    (mapping) =>
      reference.capturedLocationRevision <= mapping.fromLocationRevision &&
      isPathInsideProjectRoot({
        projectRootPath: mapping.oldRootPath,
        candidatePath: reference.requestedPath,
      }),
  );

  if (matchedMappings.length === 0) {
    return {
      kind: "unresolved",
      rejectionCode: "outside-old-root",
      reason: "该路径不落在任何已登记旧根之内；不做路径改写（可能是外部文件或其他项目根）。",
    };
  }

  if (matchedMappings.length > 1) {
    return {
      kind: "unresolved",
      rejectionCode: "ambiguous-mapping",
      reason: "多个位置映射同时覆盖该路径（嵌套/重叠旧根）；需人工裁决，不自动选择。",
    };
  }

  const matched = matchedMappings[0];
  if (matched === undefined) {
    return {
      kind: "unresolved",
      rejectionCode: "outside-old-root",
      reason: "未匹配到唯一映射；不做路径改写。",
    };
  }
  const rootSegments = matched.oldRootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRequested = reference.requestedPath.replace(/\\/g, "/");
  const relativeSuffix = normalizedRequested.startsWith(rootSegments + "/")
    ? normalizedRequested.slice(rootSegments.length)
    : "";
  const newRootNormalized = matched.newRootPath.replace(/\\/g, "/").replace(/\/+$/, "");

  return {
    kind: "resolved",
    requestedPath: reference.requestedPath,
    resolvedPath: newRootNormalized + relativeSuffix,
    appliedLocationRevision: matched.fromLocationRevision,
    wasRewritten: true,
    reason: "按项目+设备+revision 精确匹配到唯一映射，已改写为新根下的同一相对路径。",
  };
}
