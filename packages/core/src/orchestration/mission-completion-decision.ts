/**
 * AXIOMATIC-DESIGN 阶段①（2026-11-26）：**mission 完成判定的有序三角化**。
 *
 * 改造前：完成判定散落在 `main-controller.projectMissionCompletionGate` 内，
 * 同时读任务链、收据与独立裁决，且与租约/目标门禁在同一个大类里交叉影响 ⇒ 设计矩阵 FR1/3/4/5 交叉耦合。
 *
 * 改造后：本模块只做**纯编排**（按固定顺序判定），依赖以端口注入：
 *
 * ```text
 * task-chain（任务是否全 done）
 *   → receipts（严格模式下逐任务收据是否充分）
 *     → independent-verdict（严格模式下是否有已接受的独立裁决）
 * ```
 *
 * 纪律：
 * - 顺序固定（先任务链、再收据、最后裁决），每步给出结构化原因码；
 * - **不补默认值**：收据缺失/裁决缺失一律阻断；
 * - 端口抛错按"该步不通过"处理（不吞成通过）；
 * - 只读：不派发、不改状态。
 */
import { evaluateCompletionReceipt } from "./completion-receipt.js";

export interface MissionCompletionTaskView {
  readonly id: string;
  readonly status: string;
}

export interface MissionCompletionVerdictView {
  readonly isAccepted: boolean;
  readonly reasons: readonly string[];
}

export interface MissionCompletionDecisionPorts {
  /** 读取任务链任务视图（mission 不存在 ⇒ 空数组）。 */
  readonly readTaskChainTasks: (
    missionIdentifier: string,
  ) => Promise<readonly MissionCompletionTaskView[]>;
  /** 严格模式：是否要求逐任务收据。 */
  readonly isCompletionReceiptRequired: boolean;
  /** 收据判定是否要求完成控制事件。 */
  readonly requireCompletionControlEvent: boolean;
  /** 读取单个任务的完成收据（缺省 ⇒ 视为缺失）。 */
  readonly readReceipt?: (
    missionIdentifier: string,
    taskIdentifier: string,
  ) => Promise<unknown>;
  /** 读取独立完成裁决（缺省 ⇒ 视为缺失）。 */
  readonly readIndependentVerdict?: (
    missionIdentifier: string,
    doneTaskIdentifiers: readonly string[],
  ) => Promise<MissionCompletionVerdictView | null>;
}

export type MissionCompletionStepKind = "task-chain" | "receipts" | "independent-verdict";

export type MissionCompletionStepStatus = "passed" | "blocked" | "skipped";

export interface MissionCompletionStep {
  readonly step: MissionCompletionStepKind;
  readonly status: MissionCompletionStepStatus;
  readonly reasons: readonly string[];
}

export interface MissionCompletionDecision {
  readonly isAllowed: boolean;
  readonly steps: readonly MissionCompletionStep[];
  readonly blockedReasons: readonly string[];
  readonly incompleteTaskIdentifiers: readonly string[];
}

/**
 * 按固定顺序判定 mission 是否可判完成。
 *
 * 与改造前行为兼容：原因文本与顺序一致（任务链 → 收据 → 裁决），
 * 且严格模式关闭时后两步为 `skipped`（不伪造通过）。
 */
export async function decideMissionCompletion(input: {
  readonly missionIdentifier: string;
  readonly ports: MissionCompletionDecisionPorts;
}): Promise<MissionCompletionDecision> {
  const { missionIdentifier, ports } = input;
  const steps: MissionCompletionStep[] = [];
  const blockedReasons: string[] = [];

  /** 任务链读不到 ⇒ 直接上抛（读失败不等于「没有未完成任务」，绝不 fail-open）。 */
  const tasks = await ports.readTaskChainTasks(missionIdentifier);
  const incompleteTaskIdentifiers = tasks
    .filter((task) => task.status !== "done")
    .map((task) => `${task.id}(${task.status})`);

  if (incompleteTaskIdentifiers.length > 0) {
    const reasons = [`任务链仍有未完成任务: ${incompleteTaskIdentifiers.join(", ")}`];
    steps.push({ step: "task-chain", status: "blocked", reasons });
    blockedReasons.push(...reasons);
  } else {
    steps.push({ step: "task-chain", status: "passed", reasons: [] });
  }

  const doneTaskIdentifiers = tasks
    .filter((task) => task.status === "done")
    .map((task) => task.id);

  if (ports.isCompletionReceiptRequired !== true) {
    steps.push({ step: "receipts", status: "skipped", reasons: [] });
    steps.push({ step: "independent-verdict", status: "skipped", reasons: [] });
    return { isAllowed: blockedReasons.length === 0, steps, blockedReasons, incompleteTaskIdentifiers };
  }

  const insufficientReceipts: string[] = [];
  for (const taskIdentifier of doneTaskIdentifiers) {
    const receipt =
      ports.readReceipt === undefined
        ? null
        : await ports
            .readReceipt(missionIdentifier, taskIdentifier)
            .catch(() => null);
    const evaluation = evaluateCompletionReceipt({
      receipt: (receipt ?? null) as never,
      requiresCompletionControlEvent: ports.requireCompletionControlEvent === true,
    });
    if (!evaluation.isSufficient) {
      insufficientReceipts.push(`${taskIdentifier}: ${evaluation.reasons.join("；")}`);
    }
  }
  if (insufficientReceipts.length > 0) {
    const reasons = [`完成收据不足: ${insufficientReceipts.join(" | ")}`];
    steps.push({ step: "receipts", status: "blocked", reasons });
    blockedReasons.push(...reasons);
  } else {
    steps.push({ step: "receipts", status: "passed", reasons: [] });
  }

  const verdict =
    ports.readIndependentVerdict === undefined
      ? null
      : await ports
          .readIndependentVerdict(missionIdentifier, doneTaskIdentifiers)
          .catch(() => null);
  if (verdict === null || verdict.isAccepted !== true) {
    const detail = verdict === null ? "" : `：${verdict.reasons.join("；")}`;
    const reasons = [`缺少已接受的独立完成裁决${detail}`];
    steps.push({ step: "independent-verdict", status: "blocked", reasons });
    blockedReasons.push(...reasons);
  } else {
    steps.push({ step: "independent-verdict", status: "passed", reasons: [] });
  }

  return { isAllowed: blockedReasons.length === 0, steps, blockedReasons, incompleteTaskIdentifiers };
}
