/**
 * ALIGN-04-03（2026-11-10）：**任务级对账结论**（只判定，不改状态）。
 *
 * 卡内缺口："没有对账动作（不会把 running/blocked/已产出任务放回 pending 或**记录对账结论**）"。
 *
 * 本模块只产出"每个未完成任务该怎么处理"的结论，**不执行**任何状态变更：
 * 把 `running` 任务打回 pending 可能造成副作用重复，必须由人/上层决定。
 * 结论写入诊断与只读投影，供恢复前展示。
 */
import type { TaskChainDocument } from "../core/types.js";

export type TaskReconciliationAction =
  /** 已完成：无需对账。 */
  | "none"
  /** 干净 pending：可直接参与调度。 */
  | "resumable"
  /** 崩溃时在途：副作用未知，**不得**自动重跑。 */
  | "requires-side-effect-review"
  /** 等待人工裁决：**不得**自动放行。 */
  | "requires-decision"
  /** 已产出但未回执：应先确认产出，再决定是否重跑。 */
  | "requires-output-acknowledgement";

export interface TaskReconciliationVerdict {
  readonly taskIdentifier: string;
  readonly action: TaskReconciliationAction;
  readonly reason: string;
}

/**
 * 逐个未完成任务给出对账结论。
 *
 * 判定顺序与 `projectMissionResumeReadiness` 保持一致（running > blocked > 已产出 > pending），
 * 避免两处口径分叉：这里只是把同一分类翻译成"该做什么"。
 */
export function projectTaskReconciliationVerdicts(
  taskChain: TaskChainDocument,
): readonly TaskReconciliationVerdict[] {
  const verdicts: TaskReconciliationVerdict[] = [];
  for (const task of taskChain.tasks) {
    if (task.status === "done") {
      verdicts.push({
        taskIdentifier: task.id,
        action: "none",
        reason: "已完成：无需对账。",
      });
      continue;
    }
    if (task.status === "running") {
      verdicts.push({
        taskIdentifier: task.id,
        action: "requires-side-effect-review",
        reason: "崩溃时处于 running：副作用未知，不得自动重跑，需先核对。",
      });
      continue;
    }
    if (task.status === "blocked") {
      verdicts.push({
        taskIdentifier: task.id,
        action: "requires-decision",
        reason: "处于 blocked：等待人工裁决，不得自动放行。",
      });
      continue;
    }
    if (task.resultLocation !== null && task.resultLocation.trim() !== "") {
      verdicts.push({
        taskIdentifier: task.id,
        action: "requires-output-acknowledgement",
        reason: `已登记产物 ${task.resultLocation} 但未回执：先确认产出再决定是否重跑。`,
      });
      continue;
    }
    verdicts.push({
      taskIdentifier: task.id,
      action: "resumable",
      reason: "干净 pending：可直接参与调度。",
    });
  }
  return verdicts;
}

/** 是否**存在**需要人工介入的结论（用于恢复前快速判断）。 */
export function hasReconciliationBlockingVerdict(
  verdicts: readonly TaskReconciliationVerdict[],
): boolean {
  return verdicts.some(
    (verdict) =>
      verdict.action !== "none" && verdict.action !== "resumable",
  );
}
