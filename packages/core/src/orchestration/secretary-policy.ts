/**
 * SECRETARY-01-04 + ONBOARD-01-02（2026-10-21）：**默认值、启动顺序与入口规则**。
 *
 * 卡内判据：
 * - SECRETARY-01-04：两种习惯可切换、**秘书启动不阻塞项目对话**、**预算/工作时段有效**、**项目证据可追溯**；
 * - ONBOARD-01-02：项目/秘书界面入口、流程讨论→方案→**显式执行**的衔接；**不抢焦点**、**不隐式授权**、
 *   人工确认**短且易懂**。
 *
 * ## 默认口径（**待用户确认**；代码与文档均标注）
 * - 预算：**会话级 token 上限 20,000**；
 * - 工作时段：**本地时区 09:00–18:00**；
 * - 两种习惯名：`project-first`（项目优先）/ `secretary-first`（秘书优先）；
 * - 入口位置：**项目界面 + 秘书界面各一处**（同一套规则，不重复实现）。
 *
 * 纪律：预算/时段只做**判定**，不在这里改用户配置；证据缺失 ⇒ 拒绝出具条目（可追溯性不能靠"看起来像"）。
 */

/** 默认预算（待用户确认）。 */
export const DEFAULT_SECRETARY_BUDGET = {
  sessionTokenLimit: 20_000,
  isDefaultPendingUserConfirmation: true,
} as const;

/** 默认工作时段（本地时区，分钟偏移；右开）。 */
export const DEFAULT_SECRETARY_WORK_WINDOW = {
  startMinuteOfDay: 9 * 60,
  endMinuteOfDay: 18 * 60,
  timeZone: "local",
  isDefaultPendingUserConfirmation: true,
} as const;

/** 两种使用习惯。 */
export const SECRETARY_HABITS = ["project-first", "secretary-first"] as const;
export type SecretaryHabit = (typeof SECRETARY_HABITS)[number];

/** 启动判定。 */
export type SecretaryStartupDecision =
  | { readonly kind: "start"; readonly reason: string }
  | { readonly kind: "deferred"; readonly reason: string };

/**
 * 启动顺序：**秘书启动不得阻塞项目对话**。
 *
 * - `project-first` + 项目对话忙碌 ⇒ 推迟（deferred），而不是抢资源；
 * - `secretary-first` + 项目对话忙碌 ⇒ 仍然推迟准备工作，但允许"先登记日程"（不产出模型调用）。
 */
export function evaluateSecretaryStartup(input: {
  readonly habit: SecretaryHabit;
  readonly isProjectConversationBusy: boolean;
}): SecretaryStartupDecision {
  if (!input.isProjectConversationBusy) {
    return { kind: "start", reason: "项目对话空闲：可以开始整理准备（不抢资源）。" };
  }
  if (input.habit === "secretary-first") {
    return {
      kind: "deferred",
      reason: "项目对话正在进行：秘书只登记日程，**不产出模型调用、不阻塞对话**。",
    };
  }
  return {
    kind: "deferred",
    reason: "项目对话正在进行：按「项目优先」推迟整理（不阻塞对话）。",
  };
}

/** 预算判定。 */
export type SecretaryBudgetVerdict =
  | { readonly kind: "within"; readonly remainingTokenCount: number }
  | { readonly kind: "exhausted"; readonly remainingTokenCount: 0; readonly reason: string };

/** 预算：耗尽后**停止**而不是无限重试（卡内：耗时与模型调用次数有界）。 */
export function evaluateSecretaryBudget(input: {
  readonly tokensUsed: number;
  readonly sessionTokenLimit?: number;
}): SecretaryBudgetVerdict {
  const limit = input.sessionTokenLimit ?? DEFAULT_SECRETARY_BUDGET.sessionTokenLimit;
  const remaining = limit - input.tokensUsed;
  if (remaining <= 0) {
    return {
      kind: "exhausted",
      remainingTokenCount: 0,
      reason:
        "本次会话秘书预算已耗尽（" +
        String(input.tokensUsed) +
        " / " +
        String(limit) +
        "）：停止整理并如实报告，不无限重试。",
    };
  }
  return { kind: "within", remainingTokenCount: remaining };
}

/** 工作时段判定。 */
export type SecretaryWindowVerdict =
  | { readonly kind: "inside"; readonly reason: string }
  | { readonly kind: "outside"; readonly reason: string };

export function evaluateSecretaryWorkWindow(input: {
  readonly minuteOfDay: number;
  readonly startMinuteOfDay?: number;
  readonly endMinuteOfDay?: number;
}): SecretaryWindowVerdict {
  const start = input.startMinuteOfDay ?? DEFAULT_SECRETARY_WORK_WINDOW.startMinuteOfDay;
  const end = input.endMinuteOfDay ?? DEFAULT_SECRETARY_WORK_WINDOW.endMinuteOfDay;
  if (!Number.isFinite(input.minuteOfDay) || input.minuteOfDay < 0 || input.minuteOfDay > 1440) {
    return { kind: "outside", reason: "时间不可判定：按不工作处理（不猜）。" };
  }
  if (input.minuteOfDay >= start && input.minuteOfDay < end) {
    return { kind: "inside", reason: "在工作时段内。" };
  }
  return {
    kind: "outside",
    reason:
      "不在工作时段（" +
      String(Math.floor(start / 60)).padStart(2, "0") +
      ":" +
      String(start % 60).padStart(2, "0") +
      "–" +
      String(Math.floor(end / 60)).padStart(2, "0") +
      ":" +
      String(end % 60).padStart(2, "0") +
      "）：不主动整理。",
  };
}

/** 报告条目（可追溯：每条必须带证据引用）。 */
export interface SecretaryReportEntry {
  readonly entryIdentifier: string;
  readonly summaryText: string;
  readonly projectIdentifier: string;
  readonly evidenceReferences: ReadonlyArray<string>;
}

/** 出具报告条目。 */
export type SecretaryReportOutcome =
  | { readonly kind: "accepted"; readonly entry: SecretaryReportEntry }
  | { readonly kind: "rejected"; readonly reasonCode: "missing-evidence" | "missing-project"; readonly reason: string };

/** 可追溯性：**没有证据就不出具条目**（不靠"看起来像"）。 */
export function buildSecretaryReportEntry(input: {
  readonly entryIdentifier: string;
  readonly summaryText: string;
  readonly projectIdentifier: string;
  readonly evidenceReferences: ReadonlyArray<string>;
}): SecretaryReportOutcome {
  if (input.projectIdentifier.trim() === "") {
    return { kind: "rejected", reasonCode: "missing-project", reason: "缺少项目标识：无法归属证据。" };
  }
  const evidence = input.evidenceReferences.filter((reference) => reference.trim() !== "");
  if (evidence.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "missing-evidence",
      reason: "没有证据引用：不出具条目（可追溯性不能用自述替代）。",
    };
  }
  return {
    kind: "accepted",
    entry: {
      entryIdentifier: input.entryIdentifier,
      summaryText: input.summaryText,
      projectIdentifier: input.projectIdentifier,
      evidenceReferences: evidence,
    },
  };
}

/** 引导入口位置。 */
export const ONBOARDING_SURFACES = ["project", "secretary"] as const;
export type OnboardingSurface = (typeof ONBOARDING_SURFACES)[number];

/** 引导入口判定。 */
export type OnboardingEntryDecision =
  | {
      readonly kind: "show";
      readonly surface: OnboardingSurface;
      /** 恒 false：入口不得抢焦点。 */
      readonly doesStealFocus: false;
      /** 恒 false：推荐不构成授权。 */
      readonly impliesAuthorization: false;
    }
  | { readonly kind: "suppressed"; readonly reason: string };

/**
 * 入口规则：两个界面都可用；忙碌时抑制；**始终不抢焦点、不隐式授权**。
 *
 * "流程讨论→方案→显式执行"的衔接由调用方在用户**显式确认**后执行；
 * 本函数只决定"是否展示入口"。
 */
export function evaluateOnboardingEntry(input: {
  readonly surface: OnboardingSurface;
  readonly isBusy: boolean;
}): OnboardingEntryDecision {
  if (input.isBusy) {
    return {
      kind: "suppressed",
      reason: "当前忙碌（输入/授权裁决/错误恢复/高负载）：入口先不展示，避免抢焦点。",
    };
  }
  return { kind: "show", surface: input.surface, doesStealFocus: false, impliesAuthorization: false };
}

/** 显式执行确认（短且易懂的确认文案必须由用户触发）。 */
export function evaluateExplicitExecution(input: {
  readonly isUserConfirmed: boolean;
  readonly planSummaryText: string;
}): { readonly kind: "execute" | "await-confirmation"; readonly confirmationText: string } {
  if (!input.isUserConfirmed) {
    return {
      kind: "await-confirmation",
      confirmationText: "将按以下方案执行：" + input.planSummaryText + "（确认后才执行，不隐式授权）",
    };
  }
  return { kind: "execute", confirmationText: "已确认：" + input.planSummaryText };
}

/** 默认值展示（供 UI/文档提示"这些是默认值，待确认"）。 */
export function describeSecretaryDefaultsForConfirmation(): ReadonlyArray<string> {
  return [
    "秘书预算：会话级 " + String(DEFAULT_SECRETARY_BUDGET.sessionTokenLimit) + " tokens（默认值，待确认）",
    "工作时段：本地时区 09:00–18:00（默认值，待确认）",
    "使用习惯：project-first / secretary-first（默认 project-first，待确认）",
    "入口位置：项目界面 + 秘书界面各一处（默认，待确认）",
  ];
}
