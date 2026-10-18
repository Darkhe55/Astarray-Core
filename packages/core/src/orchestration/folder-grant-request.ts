/**
 * FOLDER-01-01（CLIENT-01，2026-10-18 R3）：**对话式文件夹授权**的纯判定层。
 *
 * 卡内依据（`docs/tasks/CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS.md` §1）：
 * - 模型**可以提出候选**，但**不能自行赋权**；必须由认证用户经独立授权卡明确批准；
 * - 一张卡**只处理一个文件夹 + 一项明确权限方案**，不把多路径/安装/命令堆成"全部同意"；
 * - 卡片固定展示：准确**规范化绝对路径**（不能只显示容易混淆的尾部名称）、原因、
 *   权限（只读/读写、是否含子目录、期限）、操作（批准/拒绝/查看详情）；
 * - 「检查真实路径、链接/junction、重叠根、**父目录包含其他项目**、网络路径及登记 revision；
 *   原始路径与解析目标不一致时清楚提示」；
 * - 「已属于其他项目的目录**不得**通过纳入本项目绕过 PROJECT 借阅」；
 * - 含糊权限先澄清，**不默认读写或永久化**。
 *
 * ## 本模块的边界
 *
 * - **纯函数**：不读文件、不解析符号链接、不写盘、不发起授权。真实 `realpath`/junction 解析
 *   由上层在拿到结果后做（本模块把"需要复核"如实标出来，而不是假装已验证）。
 * - **路径比较用统一口径**：`\` 归一为 `/`、折叠 `.`/`..`、盘符大写、**比较时大小写不敏感**
 *   （宁可把"看起来相同"判为重叠，也不放过真实的范围扩大）。
 * - **逐段边界**比较：`old-project-extra` **不算**在 `old-project` 内（禁止字符串前缀判定）。
 */
import { posix } from "node:path";

/** 授权权限方案（首期只有两种**明确**方案；含糊说法一律需要澄清）。 */
export type FolderGrantPermissionKind = "read-only" | "read-write";

/** 期限（不提供"永久"以外的默认；缺省由调用方显式给）。 */
export type FolderGrantDurationKind = "session" | "until-revoked";

/** 判定分类（覆盖卡内点名的情形）。 */
export type FolderGrantClassification =
  | "acceptable"
  | "ambiguous-path"
  | "not-absolute"
  | "contains-parent-traversal"
  | "inside-own-project"
  | "inside-other-project"
  | "ancestor-of-project-root"
  | "ambiguous-permission";

/** 规范化结论。 */
export interface NormalizedFolderPath {
  /** 用于比较的规范化形式（`/` 分隔、折叠 `.`/`..`、盘符大写、末尾无分隔符）。 */
  readonly comparisonPath: string;
  /** 原样保留用户输入的路径（诊断用，**不**代替展示路径）。 */
  readonly originalPath: string;
  readonly isAbsolute: boolean;
  readonly isNetworkPath: boolean;
  readonly containsParentTraversal: boolean;
  /** 含 `.`/`..`/重复分隔符等**需要规范化才能比较**的成分。 */
  readonly hasAmbiguousSegments: boolean;
}

/** 一个"项目根"登记。 */
export interface ProjectRootRegistration {
  readonly projectIdentifier: string;
  /** 已登记的根（可为同一项目的多个根）。 */
  readonly rootPath: string;
}

/** 候选请求（模型提出或用户直接提出）。 */
export interface FolderGrantCandidateInput {
  readonly projectIdentifier: string;
  readonly requestedPath: string;
  readonly permissionKind: FolderGrantPermissionKind | string;
  readonly includesSubdirectories: boolean;
  readonly durationKind: FolderGrantDurationKind | string;
  /** 提出方：模型只能提候选，不能签字。 */
  readonly proposedBy: "model" | "user";
  /**
   * 真实路径复核结论（上层做 `realpath` 后给）：
   * - `null` = **未复核**（本模块会把卡片标成"需复核"，不假装已验证）；
   * - 字符串 = 解析后的真实路径（与请求路径不一致时必须显式提示）。
   */
  readonly resolvedRealPath?: string | null;
}

/** 候选判定结论。 */
export interface FolderGrantAssessment {
  readonly classification: FolderGrantClassification;
  /** 是否**可以**呈现批准动作（仍不等于已授权）。 */
  readonly isApprovalActionAvailable: boolean;
  /** 是否需要认证用户确认（模型提出的候选恒为 true）。 */
  readonly requiresAuthenticatedUserConfirmation: boolean;
  /** 规范化路径（分类为 `not-absolute`/`ambiguous-path` 时可能为 null）。 */
  readonly normalizedPath: NormalizedFolderPath | null;
  /** 需要用户做的下一步（可直接显示）。 */
  readonly requiredUserAction: string;
  readonly reason: string;
  /** 原始路径与真实路径不一致时的提示；一致或未复核为 null。 */
  readonly realPathMismatchNotice: string | null;
  /** 是否需要上层补齐真实路径复核（junction/符号链接）。 */
  readonly requiresRealPathVerification: boolean;
}

const ALLOWED_PERMISSION_KINDS: ReadonlySet<string> = new Set([
  "read-only",
  "read-write",
]);

const ALLOWED_DURATION_KINDS: ReadonlySet<string> = new Set(["session", "until-revoked"]);

/**
 * 规范化一个路径用于**比较**。
 *
 * 注意：这不是文件系统语义（不解析链接、不查磁盘），只保证"同一路径的不同写法"可比较。
 */
export function normalizeFolderPathForComparison(rawPath: string): NormalizedFolderPath {
  const originalPath = rawPath;
  const withForwardSlashes = rawPath.trim().replaceAll("\\", "/");

  // UNC：`//server/share/...`
  const isNetworkPath = withForwardSlashes.startsWith("//");
  // 盘符：`C:/...`（大小写不敏感，统一大写）
  const driveMatch = /^([A-Za-z]):(?:\/|$)/.exec(withForwardSlashes);
  const hasDrive = driveMatch !== null;
  const isPosixAbsolute = withForwardSlashes.startsWith("/") && !isNetworkPath;
  const isAbsolute = hasDrive || isNetworkPath || isPosixAbsolute;

  const containsParentTraversal = withForwardSlashes
    .split("/")
    .some((segment) => segment === "..");

  // UNC 的前导 `//` 是合法前缀，不参与"重复分隔符"判定
  const pathBodyForAmbiguity = isNetworkPath
    ? withForwardSlashes.replace(/^\/\/+/, "")
    : withForwardSlashes;
  const hasAmbiguousSegments =
    containsParentTraversal ||
    pathBodyForAmbiguity.includes("./") ||
    pathBodyForAmbiguity.includes(".\\") ||
    pathBodyForAmbiguity.includes("//") ||
    /\/\.$/.test(pathBodyForAmbiguity) ||
    withForwardSlashes.includes("\\");

  if (!isAbsolute) {
    return {
      comparisonPath: "",
      originalPath,
      isAbsolute: false,
      isNetworkPath,
      containsParentTraversal,
      hasAmbiguousSegments,
    };
  }

  let comparisonPath: string;
  const driveLetter = driveMatch?.[1];
  if (hasDrive && driveLetter !== undefined) {
    const upperCaseDrive = driveLetter.toUpperCase();
    const remainder = withForwardSlashes.slice((driveMatch?.[0] ?? "").length);
    comparisonPath = `${upperCaseDrive}:/${posix.normalize(remainder === "" ? "/" : remainder)}`;
    comparisonPath = comparisonPath.replace(/\/+$/, "");
    if (comparisonPath === `${upperCaseDrive}:`) comparisonPath = `${upperCaseDrive}:/`;
  } else {
    comparisonPath = posix.normalize(withForwardSlashes).replace(/\/+$/, "");
    if (comparisonPath === "") comparisonPath = "/";
  }

  return {
    comparisonPath: comparisonPath.toLowerCase(),
    originalPath,
    isAbsolute: true,
    isNetworkPath,
    containsParentTraversal,
    hasAmbiguousSegments,
  };
}

/** 严格**逐段**判包含：`old-project-extra` 不属于 `old-project`。 */
export function isPathInsideOrEqual(comparisonPath: string, rootComparisonPath: string): boolean {
  if (comparisonPath === rootComparisonPath) return true;
  const rootWithSeparator = rootComparisonPath.endsWith("/")
    ? rootComparisonPath
    : `${rootComparisonPath}/`;
  return comparisonPath.startsWith(rootWithSeparator);
}

function isSegmentLabelAmbiguous(
  candidateComparisonPath: string,
  registeredRoots: ReadonlyArray<ProjectRootRegistration>,
): boolean {
  const candidateTail = candidateComparisonPath.split("/").filter(Boolean).pop() ?? "";
  if (candidateTail === "") return false;
  return registeredRoots.some((registration) => {
    const normalizedRoot = normalizeFolderPathForComparison(registration.rootPath);
    if (!normalizedRoot.isAbsolute) return false;
    const rootTail = normalizedRoot.comparisonPath.split("/").filter(Boolean).pop() ?? "";
    return rootTail === candidateTail;
  });
}

/**
 * 判定一个候选请求（**不做任何授权动作**）。
 *
 * 分类优先级（先安全、后便利）：
 * 1. 非绝对路径 / 含 `..` / 非规范写法 ⇒ 拒绝并要求给出准确绝对路径；
 * 2. 权限或期限取值含糊（不在允许集合内）⇒ 要求澄清（不得默认读写/永久）；
 * 3. 已在**本项目**根内 ⇒ 无需新增授权（不制造冗余登记）；
 * 4. 在**其他项目**根内 ⇒ 必须走 PROJECT 跨项目借阅，不得并入本项目；
 * 5. 候选是**某个项目根的祖先**（父目录）⇒ 拒绝（会扩大范围到其他项目）；
 * 6. 其余 ⇒ `acceptable`（仍须认证用户确认）。
 *
 * 关于"重叠根"：候选包含已登记根 ⇒ 落在第 5 条（fail-closed）；候选在已登记根内 ⇒
 * 落在第 3/4 条。**没有第三种重叠形态**，因此不设单独的 `overlaps-*` 分支
 * （留一个不可达分支只会骗覆盖率）。
 */
export function assessFolderGrantCandidate(input: {
  readonly candidate: FolderGrantCandidateInput;
  readonly registeredRoots: ReadonlyArray<ProjectRootRegistration>;
}): FolderGrantAssessment {
  const normalized = normalizeFolderPathForComparison(input.candidate.requestedPath);
  const requiresAuthenticatedUserConfirmation = true;
  const realPathMismatchNotice = buildRealPathMismatchNotice(input.candidate, normalized);

  if (!normalized.isAbsolute) {
    return {
      classification: "not-absolute",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: "请给出完整绝对路径（例如 D:/Assets/ProjectA）",
      reason: "相对路径无法唯一确定要纳入的文件夹；不能按当前工作目录猜测。",
      realPathMismatchNotice,
      requiresRealPathVerification: true,
    };
  }

  if (normalized.containsParentTraversal || normalized.hasAmbiguousSegments) {
    return {
      classification: normalized.containsParentTraversal
        ? "contains-parent-traversal"
        : "ambiguous-path",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: "请给出**已解析**的准确绝对路径（不要用 .. 或符号链接写法）",
      reason: normalized.containsParentTraversal
        ? "路径含 `..`，可能实际指向别的目录；必须先解析再确认。"
        : "路径写法不规范（`.`/重复分隔符/反斜杠），规范化后可能与字面不同。",
      realPathMismatchNotice,
      requiresRealPathVerification: true,
    };
  }

  if (!ALLOWED_PERMISSION_KINDS.has(input.candidate.permissionKind)) {
    return {
      classification: "ambiguous-permission",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: "请明确权限：只读（read-only）还是读写（read-write）",
      reason: "权限描述含糊；不得默认授予读写。",
      realPathMismatchNotice,
      requiresRealPathVerification: true,
    };
  }

  if (!ALLOWED_DURATION_KINDS.has(input.candidate.durationKind)) {
    return {
      classification: "ambiguous-permission",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: "请明确期限：仅本次会话（session）还是直到撤销（until-revoked）",
      reason: "期限描述含糊；不得默认永久化。",
      realPathMismatchNotice,
      requiresRealPathVerification: true,
    };
  }

  const ownProjectRoots = input.registeredRoots.filter(
    (registration) => registration.projectIdentifier === input.candidate.projectIdentifier,
  );
  const otherProjectRoots = input.registeredRoots.filter(
    (registration) => registration.projectIdentifier !== input.candidate.projectIdentifier,
  );

  const ownRootsNormalized = ownProjectRoots
    .map((registration) => normalizeFolderPathForComparison(registration.rootPath))
    .filter((root) => root.isAbsolute);

  if (
    ownRootsNormalized.some((root) =>
      isPathInsideOrEqual(normalized.comparisonPath, root.comparisonPath),
    )
  ) {
    return {
      classification: "inside-own-project",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: "无需操作：该路径已在当前项目根内，可直接按现有权限使用",
      reason: "重复登记不会增加权限；如仍看不到文件，请检查项目的其他根是否缺失。",
      realPathMismatchNotice,
      requiresRealPathVerification: normalized.hasAmbiguousSegments,
    };
  }

  const otherRootsNormalized = otherProjectRoots
    .map((registration) => normalizeFolderPathForComparison(registration.rootPath))
    .filter((root) => root.isAbsolute);

  if (
    otherRootsNormalized.some((root) =>
      isPathInsideOrEqual(normalized.comparisonPath, root.comparisonPath),
    )
  ) {
    const owningProject = otherProjectRoots.find((registration) => {
      const root = normalizeFolderPathForComparison(registration.rootPath);
      return root.isAbsolute && isPathInsideOrEqual(normalized.comparisonPath, root.comparisonPath);
    });
    return {
      classification: "inside-other-project",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: `请走跨项目借阅（只读/副本导入），归属项目：${owningProject?.projectIdentifier ?? "未知"}`,
      reason: "已属于其他项目的目录不得通过「纳入本项目」绕过项目隔离。",
      realPathMismatchNotice,
      requiresRealPathVerification: normalized.hasAmbiguousSegments,
    };
  }

  const isAncestorOfAnyRoot = [...ownRootsNormalized, ...otherRootsNormalized].some((root) =>
    isPathInsideOrEqual(root.comparisonPath, normalized.comparisonPath),
  );
  if (isAncestorOfAnyRoot) {
    return {
      classification: "ancestor-of-project-root",
      isApprovalActionAvailable: false,
      requiresAuthenticatedUserConfirmation,
      normalizedPath: normalized,
      requiredUserAction: "请改为选择**具体子目录**（父目录会连带覆盖其他项目/未授权区域）",
      reason: "该候选是某个已登记项目根的**父目录**；纳入它等于扩大范围到其他项目。",
      realPathMismatchNotice,
      requiresRealPathVerification: normalized.hasAmbiguousSegments,
    };
  }

  const tailIsAmbiguous = isSegmentLabelAmbiguous(
    normalized.comparisonPath,
    input.registeredRoots,
  );
  return {
    classification: "acceptable",
    isApprovalActionAvailable: true,
    requiresAuthenticatedUserConfirmation,
    normalizedPath: normalized,
    requiredUserAction: "等待认证用户在授权卡上逐项批准（批准前零新增权限）",
    reason: tailIsAmbiguous
      ? "可登记；但该路径的**尾部名称**与另一个项目根同名，卡片必须展示完整绝对路径以免混淆。"
      : "可登记；仍需认证用户逐项确认，模型转述不构成签字。",
    realPathMismatchNotice,
    requiresRealPathVerification: true,
  };
}

function buildRealPathMismatchNotice(
  candidate: FolderGrantCandidateInput,
  normalized: NormalizedFolderPath,
): string | null {
  if (candidate.resolvedRealPath === undefined || candidate.resolvedRealPath === null) {
    return null;
  }
  const resolved = normalizeFolderPathForComparison(candidate.resolvedRealPath);
  if (!resolved.isAbsolute) {
    return "真实路径复核结果不是绝对路径；不能据此确认。";
  }
  if (normalized.isAbsolute && resolved.comparisonPath !== normalized.comparisonPath) {
    return `原始路径与真实路径不一致：请求 ${normalized.originalPath} ⇒ 实际 ${candidate.resolvedRealPath}（可能是链接/junction）。`;
  }
  return null;
}

/** 短授权卡的视图模型（**一张卡只含一个文件夹**；无默认勾选）。 */
export interface FolderGrantCardViewModel {
  readonly cardKind: "folder-grant";
  readonly projectIdentifier: string;
  /** 完整规范化绝对路径（不得只显示尾部名称）。 */
  readonly displayAbsolutePath: string;
  readonly originalRequestedPath: string;
  readonly permissionLabel: "只读" | "读写";
  readonly includesSubdirectoriesLabel: "含子目录" | "不含子目录";
  readonly durationLabel: "仅本次会话" | "直到撤销";
  readonly permissionSummary: string;
  readonly reason: string;
  readonly requiredUserAction: string;
  /** 是否显示"批准"动作（分类不允许时为 false）。 */
  readonly isApprovalActionAvailable: boolean;
  /** 首期固定：一张卡只处理一个文件夹。 */
  readonly isBatch: false;
  /** 首期固定：一律不默认勾选。 */
  readonly isDefaultApproved: false;
  readonly operations: ReadonlyArray<"approve-one" | "reject" | "view-details">;
  /** 需要上层补齐真实路径复核（junction/符号链接）。 */
  readonly requiresRealPathVerification: boolean;
  readonly realPathMismatchNotice: string | null;
}

/**
 * 把判定结论组装成**短授权卡**。
 *
 * 卡内要求：请求/原因/权限/操作四项固定展示；详细影响可折叠，但
 * **关键范围与写入能力不得隐藏**；批量请求不进同一张卡。
 */
export function buildFolderGrantCard(input: {
  readonly candidate: FolderGrantCandidateInput;
  readonly assessment: FolderGrantAssessment;
}): FolderGrantCardViewModel {
  const normalized = input.assessment.normalizedPath;
  const permissionLabel = input.candidate.permissionKind === "read-write" ? "读写" : "只读";
  const durationLabel =
    input.candidate.durationKind === "until-revoked" ? "直到撤销" : "仅本次会话";
  const includesSubdirectoriesLabel = input.candidate.includesSubdirectories
    ? "含子目录"
    : "不含子目录";
  const permissionSummary = `${permissionLabel} · ${includesSubdirectoriesLabel} · ${durationLabel}`;

  return {
    cardKind: "folder-grant",
    projectIdentifier: input.candidate.projectIdentifier,
    displayAbsolutePath:
      normalized !== null && normalized.isAbsolute
        ? normalized.originalPath.replaceAll("\\", "/")
        : input.candidate.requestedPath,
    originalRequestedPath: input.candidate.requestedPath,
    permissionLabel,
    includesSubdirectoriesLabel,
    durationLabel,
    permissionSummary,
    reason: input.assessment.reason,
    requiredUserAction: input.assessment.requiredUserAction,
    isApprovalActionAvailable: input.assessment.isApprovalActionAvailable,
    isBatch: false,
    isDefaultApproved: false,
    operations: input.assessment.isApprovalActionAvailable
      ? ["approve-one", "reject", "view-details"]
      : ["reject", "view-details"],
    requiresRealPathVerification: input.assessment.requiresRealPathVerification,
    realPathMismatchNotice: input.assessment.realPathMismatchNotice,
  };
}

/**
 * 批量请求 ⇒ **逐项**卡片队列（卡内：批量目录请求保留队列、逐项裁决，不连续弹窗抢占用户）。
 *
 * 断言式契约：返回的队列长度必须等于输入长度，且**永远** `isBatch === false`。
 */
export function buildFolderGrantCardQueue(input: {
  readonly candidates: ReadonlyArray<FolderGrantCandidateInput>;
  readonly registeredRoots: ReadonlyArray<ProjectRootRegistration>;
}): FolderGrantCardViewModel[] {
  return input.candidates.map((candidate) =>
    buildFolderGrantCard({
      candidate,
      assessment: assessFolderGrantCandidate({ candidate, registeredRoots: input.registeredRoots }),
    }),
  );
}
