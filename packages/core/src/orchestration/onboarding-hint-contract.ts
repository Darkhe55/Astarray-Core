/**
 * ONBOARD-01-01（CLIENT-01，2026-10-19 R24）：**首次/适时提示的触发、冷却与拒绝状态**。
 *
 * 卡内依据（`docs/tasks/CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS.md` §3）：
 * - 首次提示可**跳过**，之后保留「聊聊我的工作流程」入口；**不强制问卷、不要求私密工作内容**；
 * - 适时提示只用**本地可解释信号**（完成阶段任务、主动咨询效率、允许采集范围内发现重复工作）；
 *   **不为推荐而读取新项目/完整历史或额外调用模型**；
 * - **默认同类提示至少间隔 7 天**，可关闭；首次提示之后选择「不再提示」**必须持久化生效**；
 *   **不能通过换文案绕过拒绝**；
 * - **正在输入、授权裁决、错误恢复、紧急事件或任务高负载时不弹出**；用**不抢焦点**的轻提示，
 *   不和重要授权卡混排；
 * - 推荐方案须说明输入/预期收益/所需权限与成本/停止方式，**用户选择后才另走任务和授权流程**；
 *   **不把话术当作启用实验功能的同意**；
 * - **不建设行为画像平台、不默认遥测上传**；提示触发/忽略状态**仅存客户端必要元数据**。
 *
 * ## 边界
 * 纯判定：不发提示、不读项目、不调模型、不上传遥测、不授权。
 */
/** 客户端本地保存的最小提示状态。 */
export interface OnboardingHintStateV1 {
  readonly schemaVersion: 1;
  readonly hasSeenFirstHint: boolean;
  /** 「不再提示」必须持久化（卡内硬要求）。 */
  readonly isNeverShowAgain: boolean;
  readonly lastShownAtIso: string | null;
  readonly shownCount: number;
}

/** 默认冷却：7 天。 */
export const DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS = 7;

/** 首次提示的固定文案（产品文案，卡内逐字给出）。 */
export const FIRST_ONBOARDING_HINT_TEXT =
  "可以先聊聊你的工作习惯或常见流程，例如每天重复处理什么、哪些步骤最费时间，我可以帮你设计适合的自动化方案。";

/** 提示态初始值。 */
export function createOnboardingHintState(): OnboardingHintStateV1 {
  return {
    schemaVersion: 1,
    hasSeenFirstHint: false,
    isNeverShowAgain: false,
    lastShownAtIso: null,
    shownCount: 0,
  };
}

/** 当前交互上下文（用于"不抢焦点"抑制）。 */
export interface OnboardingHintContext {
  readonly isUserTyping: boolean;
  readonly isAuthorizationPending: boolean;
  readonly isErrorRecovery: boolean;
  readonly isEmergencyActive: boolean;
  readonly isHighLoad: boolean;
}

/** 本地可解释触发信号（不读新项目、不调模型）。 */
export interface OnboardingTriggerSignals {
  readonly hasCompletedMilestone: boolean;
  readonly hasAskedAboutEfficiency: boolean;
  readonly hasDuplicateWorkDetected: boolean;
}

/** 提示判定结论。 */
export type OnboardingHintDecision =
  | { readonly kind: "show-first"; readonly text: string; readonly reason: string }
  | { readonly kind: "show-periodic"; readonly text: string; readonly reason: string }
  | {
      readonly kind: "suppress";
      readonly reasonCode:
        | "never-show-again"
        | "user-busy"
        | "authorization-in-flight"
        | "error-recovery"
        | "emergency"
        | "high-load"
        | "cooldown"
        | "no-trigger-signal"
        | "state-unknown-after-migration";
      readonly reason: string;
    };

/**
 * 判定此刻是否显示提示。
 *
 * 次序：**不再提示** → 忙碌类抑制（输入/授权/错误/紧急/高负载，**优先级最高**）
 * → 迁移后状态缺失（不重复弹首次）→ 首次 → 冷却 → 触发信号。
 */
export function evaluateOnboardingHint(input: {
  readonly nowIso: string;
  readonly state: OnboardingHintStateV1;
  readonly context: OnboardingHintContext;
  readonly triggerSignals: OnboardingTriggerSignals;
  readonly minimumIntervalDays?: number;
  /** 状态是否来自迁移且本地记录缺失（缺失时不得重复弹首次提示）。 */
  readonly isStateUnknownAfterMigration?: boolean;
}): OnboardingHintDecision {
  if (input.state.isNeverShowAgain) {
    return {
      kind: "suppress",
      reasonCode: "never-show-again",
      reason: "用户选择过「不再提示」：持久化生效，换文案也不能绕过。",
    };
  }
  if (input.context.isUserTyping) {
    return { kind: "suppress", reasonCode: "user-busy", reason: "用户正在输入：不打断。" };
  }
  if (input.context.isAuthorizationPending) {
    return {
      kind: "suppress",
      reasonCode: "authorization-in-flight",
      reason: "授权裁决进行中：不与重要授权卡混排。",
    };
  }
  if (input.context.isErrorRecovery) {
    return { kind: "suppress", reasonCode: "error-recovery", reason: "错误恢复中：先处理错误。" };
  }
  if (input.context.isEmergencyActive) {
    return { kind: "suppress", reasonCode: "emergency", reason: "紧急事件中：不弹提示。" };
  }
  if (input.context.isHighLoad) {
    return { kind: "suppress", reasonCode: "high-load", reason: "任务高负载：不抢占资源。" };
  }
  if (input.isStateUnknownAfterMigration === true && !input.state.hasSeenFirstHint) {
    return {
      kind: "suppress",
      reasonCode: "state-unknown-after-migration",
      reason: "迁移后本地状态缺失：保守不重复弹首次提示（保留手动入口）。",
    };
  }
  if (!input.state.hasSeenFirstHint) {
    return {
      kind: "show-first",
      text: FIRST_ONBOARDING_HINT_TEXT,
      reason: "首次使用：先讨论方案，不因交谈自动执行/安装/开启实验功能。",
    };
  }

  const intervalDays = input.minimumIntervalDays ?? DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS;
  if (input.state.lastShownAtIso !== null) {
    const lastShown = Date.parse(input.state.lastShownAtIso);
    const now = Date.parse(input.nowIso);
    if (!Number.isNaN(lastShown) && !Number.isNaN(now)) {
      const elapsedDays = (now - lastShown) / 86_400_000;
      if (elapsedDays < intervalDays) {
        return {
          kind: "suppress",
          reasonCode: "cooldown",
          reason: `同类提示冷却中（至少间隔 ${String(intervalDays)} 天）。`,
        };
      }
    }
  }

  const hasTriggerSignal =
    input.triggerSignals.hasCompletedMilestone ||
    input.triggerSignals.hasAskedAboutEfficiency ||
    input.triggerSignals.hasDuplicateWorkDetected;
  if (!hasTriggerSignal) {
    return {
      kind: "suppress",
      reasonCode: "no-trigger-signal",
      reason: "没有本地可解释信号：不主动打扰（不为此读取新项目或完整历史）。",
    };
  }
  return {
    kind: "show-periodic",
    text: "需要我帮你梳理一下重复流程、看看能否自动化吗？（随时可跳过或不再提示）",
    reason: "本地信号命中且已过冷却期。",
  };
}

/** 提示结果。 */
export type OnboardingHintOutcome = "shown" | "skipped" | "never-show-again";

/**
 * 记录用户对提示的处理（**不再提示必须持久化**）。
 *
 * 注意：`shown` 也会推进 `lastShownAtIso` 与计数，从而启动冷却。
 */
export function applyOnboardingHintOutcome(input: {
  readonly state: OnboardingHintStateV1;
  readonly outcome: OnboardingHintOutcome;
  readonly atIso: string;
}): OnboardingHintStateV1 {
  if (input.outcome === "never-show-again") {
    return {
      ...input.state,
      hasSeenFirstHint: true,
      isNeverShowAgain: true,
      lastShownAtIso: input.atIso,
    };
  }
  return {
    ...input.state,
    hasSeenFirstHint: true,
    isNeverShowAgain: input.state.isNeverShowAgain,
    lastShownAtIso: input.atIso,
    shownCount: input.state.shownCount + (input.outcome === "shown" ? 1 : 0),
  };
}

/**
 * 推荐方案 → 是否构成"启用实验功能"的同意。
 *
 * 卡内：**不构成**；必须另走任务与授权流程。
 */
export function evaluateRecommendationConsent(input: {
  readonly hasUserChosenToProceed: boolean;
}): {
  readonly impliesAuthorization: false;
  readonly requiresSeparateAuthorizationFlow: true;
  readonly isExecutableNow: false;
  readonly reason: string;
} {
  return {
    impliesAuthorization: false,
    requiresSeparateAuthorizationFlow: true,
    // 用户"愿意了解方案"不等于任何执行/安装/联网授权
    isExecutableNow: false,
    reason: input.hasUserChosenToProceed
      ? "用户选择了解方案：仍需逐项授权后才执行（话术不是同意）。"
      : "未选择：不执行、不安装、不开启实验功能。",
  };
}

/**
 * 提示元数据边界：仅客户端必要元数据，**不上传遥测、不做行为画像**。
 */
export function describeOnboardingMetadataBoundary(): {
  readonly uploadedTelemetryFields: ReadonlyArray<string>;
  readonly storesProfile: false;
  readonly readsProjectsForRecommendation: false;
} {
  return {
    uploadedTelemetryFields: [],
    storesProfile: false,
    readsProjectsForRecommendation: false,
  };
}
