/**
 * EVENT-01（2026-10-23）：**验收口径校验**（先定口径，再实现）。
 *
 * 卡内现状：EVENT-01 四个检查点全 pending，**没有验收口径**（事件源范围、响应期限数值、
 * 恢复默认策略、完成证据口径都未定义）⇒ 在此之前不能宣称实现或通过。
 *
 * 本模块只做一件事：**判断口径是否完整**，并明确列出缺哪几项；
 * 不伪造"通过"，也不在没有口径时隐式放行。
 */

/** 恢复默认策略。 */
export const EVENT_RECOVERY_POLICIES = [
  "automatic",
  "require-user-confirmation",
  "configurable",
] as const;
export type EventRecoveryPolicy = (typeof EVENT_RECOVERY_POLICIES)[number];

/** 验收口径（用户填写）。 */
export interface EventAcceptanceCriteria {
  /** 首期纳入的事件源（如 `process-exit`、`provider-failure`）。 */
  readonly eventSources?: ReadonlyArray<string> | null;
  /** 响应期限（秒）：超过即明确降级。 */
  readonly responseDeadlineSeconds?: number | null;
  /** 恢复默认策略。 */
  readonly recoveryPolicy?: EventRecoveryPolicy | null;
  /** 完成证据口径：每条要求的场景/检查项标识。 */
  readonly requiredEvidence?: ReadonlyArray<string> | null;
}

/** 校验结果。 */
export interface EventAcceptanceCriteriaVerdict {
  readonly isComplete: boolean;
  readonly missingFields: ReadonlyArray<
    "eventSources" | "responseDeadlineSeconds" | "recoveryPolicy" | "requiredEvidence"
  >;
  readonly problems: ReadonlyArray<string>;
  readonly reason: string;
}

/** 校验口径完整性（字段存在且合法才算完整）。 */
export function evaluateEventAcceptanceCriteria(
  criteria: EventAcceptanceCriteria,
): EventAcceptanceCriteriaVerdict {
  const missingFields: Array<
    "eventSources" | "responseDeadlineSeconds" | "recoveryPolicy" | "requiredEvidence"
  > = [];
  const problems: string[] = [];

  const eventSources = criteria.eventSources ?? null;
  if (eventSources === null || eventSources.filter((source) => source.trim() !== "").length === 0) {
    missingFields.push("eventSources");
    problems.push("缺少首期事件源清单（至少 1 项，且不得为空串）。");
  }

  const deadline = criteria.responseDeadlineSeconds;
  if (deadline === undefined || deadline === null) {
    missingFields.push("responseDeadlineSeconds");
    problems.push("缺少响应期限数值（秒）。");
  } else if (!Number.isFinite(deadline) || deadline <= 0) {
    problems.push("响应期限必须是正数秒（收到 " + String(deadline) + "）。");
  }

  const recoveryPolicy = criteria.recoveryPolicy;
  if (recoveryPolicy === undefined || recoveryPolicy === null) {
    missingFields.push("recoveryPolicy");
    problems.push("缺少恢复默认策略。");
  } else if (!(EVENT_RECOVERY_POLICIES as ReadonlyArray<string>).includes(recoveryPolicy)) {
    problems.push(
      "恢复策略只能是 " + EVENT_RECOVERY_POLICIES.join(" | ") + "（收到 " + String(recoveryPolicy) + "）。",
    );
  }

  const requiredEvidence = criteria.requiredEvidence ?? null;
  if (requiredEvidence === null || requiredEvidence.filter((item) => item.trim() !== "").length === 0) {
    missingFields.push("requiredEvidence");
    problems.push("缺少完成证据口径（至少 1 条场景/检查项）。");
  }

  const isComplete = missingFields.length === 0 && problems.length === 0;
  return {
    isComplete,
    missingFields,
    problems,
    reason: isComplete
      ? "验收口径完整：可以开始实现 EVENT-01 并按这些证据验收。"
      : "验收口径不完整：**不得**开工实现，也不得宣称通过（缺失：" +
        missingFields.join(" / ") +
        "）。",
  };
}
