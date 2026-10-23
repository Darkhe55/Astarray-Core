/**
 * RELOCATE-01（2026-10-23）：**进入项目时**的重定位提示。
 *
 * 用户口径：
 * - 只有进入项目时提示（不是启动时）；
 * - 提示提供**三个选项**：「仅查看历史」「重定位项目位置」「直接退出」；
 * - CLI 与 GUI 都要有这条提示。
 *
 * 判定：
 * - `identity-confirmed` ⇒ 提示（信息级）：可加载历史并进入只读对账，**不会自动重跑**旧任务；
 * - 其余（位置不可达/身份不符/歧义/缺失/未登记/旧格式）⇒ 提示（**阻断级**）：需要用户动作。
 */

import type { ProjectRelocationDescription } from "./project-relocation-controller.js";

/** 三个选项的稳定标识。 */
export const PROJECT_ENTRY_RELOCATION_OPTION_IDENTIFIERS = [
  "view-history-only",
  "relocate",
  "exit",
] as const;
export type ProjectEntryRelocationOptionIdentifier =
  (typeof PROJECT_ENTRY_RELOCATION_OPTION_IDENTIFIERS)[number];

/** 单个选项。 */
export interface ProjectEntryRelocationOption {
  readonly identifier: ProjectEntryRelocationOptionIdentifier;
  readonly label: "仅查看历史" | "重定位项目位置" | "直接退出";
  readonly isEnabled: boolean;
  /** 禁用原因（启用时为 null）。 */
  readonly reasonIfDisabled: string | null;
}

/** 进入项目时的提示。 */
export interface ProjectEntryRelocationPrompt {
  /** 是否应该展示提示（进入项目时调用；启动时不调用）。 */
  readonly shouldPrompt: boolean;
  /** 阻断级：未处理前不应执行该项目的新任务。 */
  readonly isBlocking: boolean;
  readonly classification: string;
  readonly titleText: string;
  readonly messageText: string;
  readonly requiredUserAction: string;
  /** 三个选项（顺序固定：仅查看历史 / 重定位 / 退出）。 */
  readonly options: ReadonlyArray<ProjectEntryRelocationOption>;
}

/**
 * 构建"进入项目时"的提示。
 *
 * 纪律：
 * 1. **身份一致也要提示**（信息级）——避免用户以为"进入项目就自动重跑旧任务"；
 * 2. 阻断级提示必须写清"需要你做什么"，不能只写"出错了"；
 * 3. **仅查看历史**只在 `isHistoryLoadable` 时可用（身份不符/不可达时不给假入口）；
 * 4. 不在这里执行任何恢复/写入动作（提示 ≠ 授权）。
 */
export function buildProjectEntryRelocationPrompt(
  description: ProjectRelocationDescription,
): ProjectEntryRelocationPrompt {
  const outcome = description.outcome;
  const options = buildOptions(outcome.isHistoryLoadable);

  if (outcome.classification === "identity-confirmed") {
    return {
      shouldPrompt: true,
      isBlocking: false,
      classification: outcome.classification,
      titleText: "项目位置已确认",
      messageText:
        "可以加载该项目的历史并进入只读恢复对账；**不会自动重跑**旧任务（确认位置不等于批准执行）。",
      requiredUserAction: outcome.requiredUserAction,
      options,
    };
  }
  return {
    shouldPrompt: true,
    isBlocking: true,
    classification: outcome.classification,
    titleText: "项目可能需要重新定位",
    messageText: outcome.reason + " 需要你执行：「" + outcome.requiredUserAction + "」。",
    requiredUserAction: outcome.requiredUserAction,
    options,
  };
}

function buildOptions(isHistoryLoadable: boolean): ReadonlyArray<ProjectEntryRelocationOption> {
  return [
    {
      identifier: "view-history-only",
      label: "仅查看历史",
      isEnabled: isHistoryLoadable,
      reasonIfDisabled: isHistoryLoadable
        ? null
        : "该状态下不能加载历史（需先完成重定位或关联，避免套用不属于该项目的旧历史）。",
    },
    {
      identifier: "relocate",
      label: "重定位项目位置",
      isEnabled: true,
      reasonIfDisabled: null,
    },
    {
      identifier: "exit",
      label: "直接退出",
      isEnabled: true,
      reasonIfDisabled: null,
    },
  ];
}

/** 用户选择的结果。 */
export type ProjectEntryRelocationChoiceOutcome =
  | {
      readonly kind: "allowed";
      readonly action: "view-history-only";
      readonly isExecutionAllowed: false;
      readonly message: string;
    }
  | {
      readonly kind: "blocked";
      readonly action: "view-history-only" | "relocate" | "exit";
      readonly reasonCode: "history-not-loadable" | "relocation-not-applied" | "unknown-option";
      readonly message: string;
    }
  | {
      readonly kind: "exit";
      readonly action: "exit";
      readonly message: string;
    };

/**
 * 应用用户的三个选择之一。
 *
 * - `exit` ⇒ 关闭该项目视图（**不**执行任何恢复）；
 * - `view-history-only` ⇒ 仅当历史可加载时允许，且**不批准执行**；
 * - `relocate` ⇒ 进入重定位流程（本函数**不**执行 apply，只返回需要人工确认的指引）。
 */
export function applyProjectEntryRelocationChoice(input: {
  readonly description: ProjectRelocationDescription;
  readonly choice: string;
}): ProjectEntryRelocationChoiceOutcome {
  const outcome = input.description.outcome;
  if (input.choice === "exit") {
    return { kind: "exit", action: "exit", message: "已退出该项目视图（未做任何恢复）。" };
  }
  if (input.choice === "view-history-only") {
    if (!outcome.isHistoryLoadable) {
      return {
        kind: "blocked",
        action: "view-history-only",
        reasonCode: "history-not-loadable",
        message:
          "该状态下不能加载历史：" + outcome.reason + " 请先选择「重定位项目位置」。",
      };
    }
    return {
      kind: "allowed",
      action: "view-history-only",
      isExecutionAllowed: false,
      message: "仅查看历史：可只读对账，**不会**执行任务，也不会自动重跑旧任务。",
    };
  }
  if (input.choice === "relocate") {
    return {
      kind: "blocked",
      action: "relocate",
      reasonCode: "relocation-not-applied",
      message:
        "重定位需要你确认新位置后由控制面执行（当前只提供指引，不自动改写登记）：" +
        outcome.requiredUserAction,
    };
  }
  return {
    kind: "blocked",
    action: "exit",
    reasonCode: "unknown-option",
    message: "未知选项 `" + input.choice + "`：只接受 view-history-only / relocate / exit。",
  };
}
