/**
 * SECRETARY-01-01（CLIENT-01，2026-10-18 R6）：实验性同级秘书 Agent 的**契约层**。
 *
 * 卡内依据（`docs/tasks/CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS.md` §2）：
 * - **默认关闭**，仅认证用户显式开启；默认**不创建实例**；
 * - 秘书与主 Agent **同级**，不是任何主 Agent 的上级；使用独立 `agentInstanceId`、记忆、
 *   模型配置和预算；
 * - 工作区**严格限定在客户端专用数据目录中的秘书域**，不是用户目录、也不是安装目录；
 *   运行时解析并登记，**不让模型自行指定**；不通过扩展根获取项目文件权限；
 * - 秘书**不编码、不验收、不执行项目工具、不替项目调度者合并 Git**；
 *   模型工具只有**只读报告查询/状态查询**，不因秘书角色获得任意文件写入；
 * - 项目可见列表由**用户先选择**（默认空）；秘书不能直接读项目目录或其他 Agent 私人存档；
 * - 用户经秘书下达项目任务时，秘书只生成**带目标项目的转交提案**，**目标不明确先询问**，
 *   **不得一条指令广播所有项目**。
 *
 * ## 边界
 * 本模块是**纯判定**：不创建实例、不写盘、不解析真实路径、不发起模型调用。
 * 它回答"能不能开启/能不能执行该能力/该转交给谁"，不代替权限引擎与模式约束。
 */
import {
  isPathInsideOrEqual,
  normalizeFolderPathForComparison,
} from "./folder-grant-request.js";

/** 秘书可用的**只读**能力（就这两项）。 */
export const SECRETARY_ALLOWED_CAPABILITIES: ReadonlyArray<string> = [
  "read-only-report-query",
  "status-query",
];

/** 秘书**永远不可**获得的能力（卡内逐条点名）。 */
export const SECRETARY_DENIED_CAPABILITIES: ReadonlyArray<string> = [
  "project-source-read",
  "authorize-for-user",
  "manage-project-execution",
  "git-merge",
];

/** 启用判定结论。 */
export type SecretaryActivationReasonCode =
  | "activatable"
  | "disabled"
  | "not-authenticated"
  | "workspace-not-absolute"
  | "workspace-outside-client-data"
  | "workspace-too-broad";

export interface SecretaryActivationAssessment {
  readonly reasonCode: SecretaryActivationReasonCode;
  /** 是否可以创建/启动秘书实例（仍不等于授予项目权限）。 */
  readonly isActivatable: boolean;
  /** 需要用户做的下一步（可直接显示）。 */
  readonly requiredUserAction: string;
  readonly reason: string;
  /** 规范化后的工作区路径（未通过时为 null）。 */
  readonly normalizedWorkspacePath: string | null;
}

/**
 * 判定秘书是否可启用。
 *
 * 判定次序（先安全）：
 * 1. 实验开关**默认关闭**（`undefined`/`false` ⇒ `disabled`）；
 * 2. 非认证用户 ⇒ `not-authenticated`；
 * 3. 工作区必须是绝对路径 ⇒ 否则 `workspace-not-absolute`；
 * 4. 工作区必须在客户端专用数据目录内 ⇒ 否则 `workspace-outside-client-data`；
 * 5. 工作区不得是**整个**客户端数据目录、用户主目录、安装目录，也不得是它们的**祖先**
 *    ⇒ `workspace-too-broad`（防止"秘书域"变成整盘）。
 */
export function evaluateSecretaryActivation(input: {
  readonly isExperimentEnabled: boolean | undefined;
  readonly isAuthenticatedUser: boolean;
  readonly workspacePath: string;
  readonly clientDataDirectoryPath: string;
  readonly userHomeDirectoryPath: string;
  readonly installationDirectoryPath: string;
}): SecretaryActivationAssessment {
  if (input.isExperimentEnabled !== true) {
    return {
      reasonCode: "disabled",
      isActivatable: false,
      requiredUserAction: "如确需使用，请由认证用户在设置中显式开启该实验功能（默认关闭）",
      reason: "实验性秘书默认关闭；关闭时不创建任何实例。",
      normalizedWorkspacePath: null,
    };
  }

  if (!input.isAuthenticatedUser) {
    return {
      reasonCode: "not-authenticated",
      isActivatable: false,
      requiredUserAction: "请先完成本地认证",
      reason: "只有认证用户可以开启实验性秘书。",
      normalizedWorkspacePath: null,
    };
  }

  const workspace = normalizeFolderPathForComparison(input.workspacePath);
  if (!workspace.isAbsolute) {
    return {
      reasonCode: "workspace-not-absolute",
      isActivatable: false,
      requiredUserAction: "工作区必须是运行时解析出的绝对路径（不接受模型指定）",
      reason: "相对路径无法确定秘书域位置。",
      normalizedWorkspacePath: null,
    };
  }

  const clientData = normalizeFolderPathForComparison(input.clientDataDirectoryPath);
  const userHome = normalizeFolderPathForComparison(input.userHomeDirectoryPath);
  const installation = normalizeFolderPathForComparison(input.installationDirectoryPath);

  if (
    !clientData.isAbsolute ||
    !isPathInsideOrEqual(workspace.comparisonPath, clientData.comparisonPath) ||
    workspace.comparisonPath === clientData.comparisonPath
  ) {
    return {
      reasonCode: "workspace-outside-client-data",
      isActivatable: false,
      requiredUserAction: "请使用客户端数据目录下的专职子目录（例如 <client-data>/secretary）",
      reason:
        workspace.isAbsolute && workspace.comparisonPath === clientData.comparisonPath
          ? "工作区不能是整个客户端数据目录；必须是其中**专职的秘书子目录**。"
          : "工作区必须位于客户端专用数据目录内。",
      normalizedWorkspacePath: null,
    };
  }

  const isTooBroad =
    (userHome.isAbsolute &&
      (workspace.comparisonPath === userHome.comparisonPath ||
        isPathInsideOrEqual(userHome.comparisonPath, workspace.comparisonPath))) ||
    (installation.isAbsolute &&
      (workspace.comparisonPath === installation.comparisonPath ||
        isPathInsideOrEqual(installation.comparisonPath, workspace.comparisonPath)));
  if (isTooBroad) {
    return {
      reasonCode: "workspace-too-broad",
      isActivatable: false,
      requiredUserAction: "请改用客户端数据目录下的专职子目录，不要覆盖用户主目录或安装目录",
      reason: "工作区过宽：它等于或包含用户主目录/安装目录，等于把整盘交给秘书。",
      normalizedWorkspacePath: null,
    };
  }

  return {
    reasonCode: "activatable",
    isActivatable: true,
    requiredUserAction: "已可开启；秘书的项目可见列表仍需你逐项选择（默认空）",
    reason: "开关已开启且工作区落在客户端数据目录的专职子目录内。",
    normalizedWorkspacePath: workspace.comparisonPath,
  };
}

/** 工具/能力请求判定。 */
export type SecretaryCapabilityDecision =
  | { readonly isAllowed: true; readonly capability: string }
  | {
      readonly isAllowed: false;
      readonly reasonCode: "capability-denied" | "project-not-visible";
      readonly reason: string;
    };

/**
 * 判定秘书能否执行某个能力。
 *
 * - 不在 `SECRETARY_ALLOWED_CAPABILITIES` 内（含被点名禁止的四项）⇒ `capability-denied`；
 * - 能力需要项目可见性时，项目不在用户选择的可见列表内 ⇒ `project-not-visible`。
 */
export function evaluateSecretaryCapabilityRequest(input: {
  readonly capability: string;
  readonly projectIdentifier?: string | null;
  readonly visibleProjectIdentifiers: ReadonlyArray<string>;
}): SecretaryCapabilityDecision {
  if (!SECRETARY_ALLOWED_CAPABILITIES.includes(input.capability)) {
    return {
      isAllowed: false,
      reasonCode: "capability-denied",
      reason: `秘书不可执行该能力（${input.capability}）：只允许只读报告查询与状态查询。`,
    };
  }
  if (input.projectIdentifier !== undefined && input.projectIdentifier !== null) {
    if (!input.visibleProjectIdentifiers.includes(input.projectIdentifier)) {
      return {
        isAllowed: false,
        reasonCode: "project-not-visible",
        reason: "该项目不在用户选定的可见项目列表内。",
      };
    }
  }
  return { isAllowed: true, capability: input.capability };
}

/** 可见项目列表判定。 */
export interface SecretaryVisibilityResult {
  readonly visibleProjectIdentifiers: ReadonlyArray<string>;
  /** 被拒绝的未知项目（不静默丢弃）。 */
  readonly unknownProjectIdentifiers: ReadonlyArray<string>;
  /** 是否沿用默认（空）。 */
  readonly isDefaultEmpty: boolean;
  readonly reason: string;
}

/**
 * 用户选择的可见项目 ⇒ 可见列表。
 *
 * - **默认空**：未选择任何项目 ⇒ 空列表（秘书看不到任何项目）；
 * - 未知项目 ⇒ 记入 `unknownProjectIdentifiers` 并从可见列表剔除（不猜测对应）；
 * - 去重且保持稳定顺序（按输入次序）。
 */
export function buildSecretaryVisibleProjects(input: {
  readonly requestedProjectIdentifiers: ReadonlyArray<string>;
  readonly knownProjectIdentifiers: ReadonlyArray<string>;
}): SecretaryVisibilityResult {
  const unknown: string[] = [];
  const visible: string[] = [];
  for (const projectIdentifier of input.requestedProjectIdentifiers) {
    if (!input.knownProjectIdentifiers.includes(projectIdentifier)) {
      if (!unknown.includes(projectIdentifier)) unknown.push(projectIdentifier);
      continue;
    }
    if (!visible.includes(projectIdentifier)) visible.push(projectIdentifier);
  }
  return {
    visibleProjectIdentifiers: visible,
    unknownProjectIdentifiers: unknown,
    isDefaultEmpty: visible.length === 0,
    reason:
      visible.length === 0
        ? "尚未选择任何项目：秘书看不到任何项目（默认空）。"
        : `已选择 ${String(visible.length)} 个项目；未选择的项目对秘书不可见。`,
  };
}

/** 任务转交提案判定。 */
export type SecretaryTaskRelayDecision =
  | {
      readonly kind: "proposal-created";
      readonly targetProjectIdentifier: string;
      /** 控制面保留原始用户来源（秘书不能冒充用户层级 0）。 */
      readonly keepsOriginalUserSource: true;
      readonly isBroadcast: false;
    }
  | { readonly kind: "needs-clarification"; readonly reason: string; readonly isBroadcast: false }
  | { readonly kind: "rejected"; readonly reason: string; readonly isBroadcast: false };

/**
 * 用户经秘书下达项目任务 ⇒ 转交提案。
 *
 * - **缺少目标项目**（null/空）⇒ `needs-clarification`（先询问），**绝不广播**；
 * - 目标项目未知 ⇒ `rejected`；
 * - 目标明确 ⇒ `proposal-created`，并声明保留原始用户来源。
 */
export function planSecretaryTaskRelay(input: {
  readonly targetProjectIdentifier: string | null | undefined;
  readonly knownProjectIdentifiers: ReadonlyArray<string>;
}): SecretaryTaskRelayDecision {
  const target = input.targetProjectIdentifier?.trim() ?? "";
  if (target === "") {
    return {
      kind: "needs-clarification",
      reason: "未指定目标项目：先询问用户要交给哪个项目，不得广播到所有项目。",
      isBroadcast: false,
    };
  }
  if (!input.knownProjectIdentifiers.includes(target)) {
    return {
      kind: "rejected",
      reason: `目标项目不在已知项目列表内（${target}）：不猜测归属。`,
      isBroadcast: false,
    };
  }
  return {
    kind: "proposal-created",
    targetProjectIdentifier: target,
    keepsOriginalUserSource: true,
    isBroadcast: false,
  };
}
