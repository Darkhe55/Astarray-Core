/**
 * RELOCATE-01（2026-10-23）：**进入项目时**的重定位提示。
 *
 * 用户口径（2026-10-23）：重定位提示只在**进入项目**时出现，不在应用启动时刷屏；
 * CLI 与 GUI 都要有这条提示。
 *
 * 判定：
 * - `identity-confirmed` ⇒ 提示（信息级）：可加载历史并进入只读对账，**不会自动重跑**旧任务；
 * - 其余（位置不可达/身份不符/歧义/缺失/未登记/旧格式）⇒ 提示（**阻断级**）：需要用户动作。
 */

import type { ProjectRelocationDescription } from "./project-relocation-controller.js";

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
}

/**
 * 构建"进入项目时"的提示。
 *
 * 纪律：
 * 1. **身份一致也要提示**（信息级）——避免用户以为"进入项目就自动重跑旧任务"；
 * 2. 阻断级提示必须写清"需要你做什么"，不能只写"出错了"；
 * 3. 不在这里执行任何恢复/写入动作（提示 ≠ 授权）。
 */
export function buildProjectEntryRelocationPrompt(
  description: ProjectRelocationDescription,
): ProjectEntryRelocationPrompt {
  const outcome = description.outcome;
  if (outcome.classification === "identity-confirmed") {
    return {
      shouldPrompt: true,
      isBlocking: false,
      classification: outcome.classification,
      titleText: "项目位置已确认",
      messageText:
        "可以加载该项目的历史并进入只读恢复对账；**不会自动重跑**旧任务（确认位置不等于批准执行）。",
      requiredUserAction: outcome.requiredUserAction,
    };
  }
  return {
    shouldPrompt: true,
    isBlocking: true,
    classification: outcome.classification,
    titleText: "项目可能需要重新定位",
    messageText: outcome.reason + " 需要你执行：「" + outcome.requiredUserAction + "」。",
    requiredUserAction: outcome.requiredUserAction,
  };
}
