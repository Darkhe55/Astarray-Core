/**
 * RELOCATE-01 检查点 01（身份与检测）：**纯判定**，无 I/O、无副作用（2026-10-18 第 8 轮）。
 *
 * 依据 `docs/tasks/RELOCATE01_COLD_START_PROJECT_RELINK_TASK_CARD.md` §2／§4：
 *
 * - 冷启动只有 5 种合法结论 + "无登记"；每种都必须**fail-closed**；
 * - **加载历史 ≠ 批准执行**（身份一致时也只允许"只读恢复对账"，不直接重跑）；
 * - **路径存在 ≠ 身份一致**：目录复制会连 `projectIdentifier` 一起复制，ID 只是证据；
 * - **多个候选同身份 ⇒ 必须由用户选**，不得自动猜测；
 * - **映射不得用字符串前缀判包含**（`old-project-extra` 不属于 `old-project`）。
 *
 * 本模块**不读文件、不启动模型、不修改任务状态** —— 只把观测分类并给出"能否加载历史/能否执行"。
 */

/** 冷启动身份分类（卡内 §2 的五行 + 无登记）。 */
export type ProjectRelocationClassification =
  | "identity-confirmed"
  | "location-unreachable"
  | "identity-mismatch"
  | "identity-ambiguous"
  | "identity-missing"
  | "unregistered";

/** 需要用户/控制面采取的动作（**模型不得代签**）。 */
export type ProjectRelocationRequiredUserAction =
  | "只读恢复对账"
  | "待用户关联"
  | "阻止套用旧历史"
  | "用户选择继续原项目或独立打开"
  | "走旧格式关联/恢复流程"
  | "先建立登记";

/** 冷启动时能取到的观测（全部由控制面提供，本模块不自行读取）。 */
export interface ProjectRelocationObservation {
  /** 登记的项目标识；缺失表示旧格式或未登记。 */
  readonly registeredProjectIdentifier: string | null;
  /** 登记的根路径；缺失表示未登记。 */
  readonly registeredRootPath: string | null;
  /** 本次启动时用户选择的根路径（用于展示与后续映射）。 */
  readonly currentRootPath: string;
  /** 登记根路径当前是否可访问（存在 + 有权限 + 未被移走）。 */
  readonly isRegisteredRootAccessible: boolean;
  /** 在**当前根**实际观测到的项目标识（来自项目内标识文件；读不到为 null）。 */
  readonly observedProjectIdentifierAtCurrentRoot: string | null;
  /** 与登记标识**相同**的候选（多于一个 ⇒ 歧义）。 */
  readonly candidateIdentifiersWithSameIdentity: readonly string[];
  /** 登记本身是否损坏（可解析但字段非法、或文件损坏）。 */
  readonly isRegistrationCorrupted: boolean;
  /** 是否存在**旧格式**登记文件（无 schemaVersion；文件存在 ⇒ 不是 unregistered）。 */
  readonly isLegacyRegistration?: boolean;
}

/** 判定结果。 */
export interface ProjectRelocationOutcome {
  readonly classification: ProjectRelocationClassification;
  /** 是否允许加载该项目历史（只读）。 */
  readonly isHistoryLoadable: boolean;
  /** 是否允许执行该项目的任务（**身份一致时也为 false**：必须先只读对账）。 */
  readonly isExecutionAllowed: boolean;
  readonly requiredUserAction: ProjectRelocationRequiredUserAction;
  /** 面向用户的原因说明（不得泄露内部路径细节以外的东西）。 */
  readonly reason: string;
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/**
 * 共享兜底标识（2026-10-18 第 9 轮审计发现）。
 *
 * `application-runtime.ts` 用 `options.projectIdentifier ?? "workspace"` 兜底 ⇒
 * **所有未显式命名的项目会共享同一个标识 `workspace`**。若把它当作真正的身份，
 * 冷启动就会把**不同项目**误判为"身份一致"（正是卡内禁止的"同名目录不能单独证明身份"）。
 *
 * ⇒ 本判定把该兜底值视为**不可辨识身份**（同"标识缺失"处理，fail-closed）。
 */
export const SHARED_FALLBACK_PROJECT_IDENTIFIER = "workspace";

/** 是否为**可辨识**的项目身份标识（非空且不是共享兜底值）。 */
export function isIdentifiableProjectIdentifier(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== SHARED_FALLBACK_PROJECT_IDENTIFIER;
}

/**
 * 冷启动身份分类。
 *
 * 判定顺序是**刻意的 fail-closed 顺序**：越"不确定"的情况越先返回，避免流到"身份一致"分支。
 */
export function classifyProjectRelocation(
  observation: ProjectRelocationObservation,
): ProjectRelocationOutcome {
  // ① 登记损坏 ⇒ 旧格式流程，绝不伪称验证成功
  if (observation.isRegistrationCorrupted) {
    return {
      classification: "identity-missing",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "走旧格式关联/恢复流程",
      reason: "项目登记已损坏，无法验证身份；需走旧格式关联/恢复流程，不视为验证成功。",
    };
  }

  // ② 旧格式登记（文件存在但缺 schemaVersion）⇒ 走旧格式流程，不得当作未登记
  if (observation.isLegacyRegistration === true) {
    return {
      classification: "identity-missing",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "走旧格式关联/恢复流程",
      reason: "存在旧格式登记（缺少 schemaVersion）；需用户显式关联后迁移，不自动升级、不伪称验证成功。",
    };
  }

  // ③ 完全没有登记（标识与根都缺失）
  if (
    !isIdentifiableProjectIdentifier(observation.registeredProjectIdentifier) &&
    isBlank(observation.registeredRootPath)
  ) {
    return {
      classification: "unregistered",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "先建立登记",
      reason: "该项目没有登记记录；同名目录或相同 Git 远端都不能单独证明身份。",
    };
  }

  // ③ 有根但标识缺失 ⇒ 旧格式（不得推断）
  if (!isIdentifiableProjectIdentifier(observation.registeredProjectIdentifier)) {
    return {
      classification: "identity-missing",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "走旧格式关联/恢复流程",
      reason: "登记缺少项目标识（旧格式）；需用户明确关联后再迁移，不伪称验证成功。",
    };
  }

  // ④ 登记根不可访问 ⇒ 待关联（不自动新建空目录）
  if (!observation.isRegisteredRootAccessible) {
    return {
      classification: "location-unreachable",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "待用户关联",
      reason:
        "登记的项目根路径当前不可访问（不存在、设备未挂载或无权限）；" +
        "待用户重新关联，**不自动新建**空目录，也不把任务标为完成或失败。",
    };
  }

  // ⑤ 多个候选同身份 ⇒ 必须用户选择，不自动猜测
  if (observation.candidateIdentifiersWithSameIdentity.length > 1) {
    return {
      classification: "identity-ambiguous",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "用户选择继续原项目或独立打开",
      reason:
        "存在多个身份相同的候选位置（很可能是目录复制）；" +
        "身份标识相同不构成自动授权，需用户选择继续原项目或作为独立项目打开。",
    };
  }

  // ⑥ 当前根读不到标识 ⇒ 无法验证，不得乐观放行
  if (!isIdentifiableProjectIdentifier(observation.observedProjectIdentifierAtCurrentRoot)) {
    return {
      classification: "identity-missing",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "走旧格式关联/恢复流程",
      reason: "在当前根未读取到项目标识，无法验证身份；不视为验证成功。",
    };
  }

  // ⑦ 标识不同 ⇒ 阻止（目录复制后 ID 相同也不行，此处是 ID 不同）
  if (
    observation.observedProjectIdentifierAtCurrentRoot !==
    observation.registeredProjectIdentifier
  ) {
    return {
      classification: "identity-mismatch",
      isHistoryLoadable: false,
      isExecutionAllowed: false,
      requiredUserAction: "阻止套用旧历史",
      reason:
        "当前根的项目标识与登记不一致；阻止套用旧历史与执行该项目的任务。" +
        "如需继续原项目，请由用户选择正确位置或作为独立项目打开。",
    };
  }

  // ⑧ 身份一致 ⇒ 可加载历史（只读对账），**仍不批准执行**
  return {
    classification: "identity-confirmed",
    isHistoryLoadable: true,
    isExecutionAllowed: false,
    requiredUserAction: "只读恢复对账",
    reason:
      "身份一致：可加载历史并进入只读恢复对账；" +
      "**不直接重跑**历史任务，用户确认位置不等于批准执行所有旧任务。",
  };
}

/** 把若干段路径拼成规范形式（不触盘）。 */
function normalizePathSegments(pathValue: string): string[] {
  const normalizedSeparators = pathValue.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of normalizedSeparators.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:/.test(pathValue) || pathValue.startsWith("//");
}

/**
 * 判断 `candidatePath` 是否位于 `projectRootPath` 之内。
 *
 * **禁止字符串前缀判断**（`old-project-extra` 不属于 `old-project`）；
 * Windows 盘符/UNC 按大小写不敏感处理，POSIX 保留大小写语义（§4 跨平台规范复用）。
 */
export function isPathInsideProjectRoot(input: {
  readonly projectRootPath: string;
  readonly candidatePath: string;
}): boolean {
  const { projectRootPath, candidatePath } = input;
  if (projectRootPath.trim() === "" || candidatePath.trim() === "") return false;

  const isWindowsSemantics =
    looksLikeWindowsPath(projectRootPath) || looksLikeWindowsPath(candidatePath);
  const normalizeCase = (segments: string[]): string[] =>
    isWindowsSemantics ? segments.map((segment) => segment.toLowerCase()) : segments;

  const rootSegments = normalizeCase(normalizePathSegments(projectRootPath));
  const candidateSegments = normalizeCase(normalizePathSegments(candidatePath));

  if (rootSegments.length === 0) return false;
  if (candidateSegments.length < rootSegments.length) return false;

  return rootSegments.every(
    (rootSegment, index) => candidateSegments[index] === rootSegment,
  );
}
