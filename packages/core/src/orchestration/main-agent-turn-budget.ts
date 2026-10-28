/**
 * ALIGN-01-05（2026-10-28）：主 Agent **单条处理预算**（默认 180 秒）与超期记账。
 *
 * 卡内要求：任务交付提案后立即释放主 Agent 的任务等待；单条主 Agent 处理预算上限
 * 180 秒，耗尽时**保存已知进度**并明确返回"待补信息/待继续"，**不得伪造已分发**；
 * 不能用无限模型重试占住通信。
 *
 * 本模块只负责**记账与判定**（纯函数 + 常量），不发起模型调用、不改调度：
 * - 预算常量与 SMART-01-04 的派发期限同源（`MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS`）；
 * - 记录里显式包含 `isTaskDispatched: false` —— 主 Agent 的一轮处理**从不**等于任务已派发；
 * - 超期记录保留已产生的输出字数与"下一步动作"文案，供 UI/用户直接读到"要补什么"。
 *
 * 真正的超时中止由调用方（`MainController.respondInPonderMode`）用
 * `AbortSignal.timeout` + `AbortSignal.any` 完成；本模块不持有计时器。
 */
import { MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS } from "./main-agent-deadline-supervisor.js";

/** 单条主 Agent 处理的默认预算：180 秒（与 SMART-01 卡内明文一致）。 */
export const MAIN_AGENT_TURN_BUDGET_MILLISECONDS =
  MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS;

export type MainAgentTurnOutcome = "completed" | "timed-out" | "cancelled";

export interface MainAgentTurnProgressRecord {
  readonly turnIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly startedAtIso: string;
  readonly endedAtIso: string;
  readonly budgetMilliseconds: number;
  readonly elapsedMilliseconds: number;
  readonly outcome: MainAgentTurnOutcome;
  /** 已流式产出的字符数（"已知进展"的可核对量化，不代表结论正确）。 */
  readonly streamedCharacterCount: number;
  readonly knownProgressSummary: string;
  /** 恒 false：主 Agent 的思考/答复**不等于**任务已派发。 */
  readonly isTaskDispatched: false;
  /** 给用户的下一步动作（超期时是"待补信息/待继续"，不是"已完成"）。 */
  readonly nextActionText: string;
}

export interface BuildMainAgentTurnProgressInput {
  readonly turnIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly startedAtMilliseconds: number;
  readonly endedAtMilliseconds: number;
  readonly budgetMilliseconds: number;
  readonly outcome: MainAgentTurnOutcome;
  readonly streamedCharacterCount: number;
}

/**
 * 构造一条可持久化的"本轮处理"记录。
 *
 * 超期文案刻意写死为"待补信息/待继续"，避免调用方用"已完成/已派发"包装超时。
 */
export function buildMainAgentTurnProgressRecord(
  input: BuildMainAgentTurnProgressInput,
): MainAgentTurnProgressRecord {
  const elapsedMilliseconds = Math.max(
    0,
    input.endedAtMilliseconds - input.startedAtMilliseconds,
  );
  const isTimedOut = input.outcome === "timed-out";
  return {
    turnIdentifier: input.turnIdentifier,
    conversationIdentifier: input.conversationIdentifier,
    startedAtIso: new Date(input.startedAtMilliseconds).toISOString(),
    endedAtIso: new Date(input.endedAtMilliseconds).toISOString(),
    budgetMilliseconds: input.budgetMilliseconds,
    elapsedMilliseconds,
    outcome: input.outcome,
    streamedCharacterCount: input.streamedCharacterCount,
    knownProgressSummary: isTimedOut
      ? `已达 ${Math.round(input.budgetMilliseconds / 1000)} 秒预算上限；已产出 ${input.streamedCharacterCount} 字，未派发任何任务`
      : input.outcome === "cancelled"
        ? `已取消；已产出 ${input.streamedCharacterCount} 字，未派发任何任务`
        : `已完成本轮答复；已产出 ${input.streamedCharacterCount} 字（答复完成不等于任务已派发）`,
    isTaskDispatched: false,
    nextActionText: isTimedOut
      ? "主 Agent 本轮处理超时：请补充信息或指示「继续」，系统将从已知进展续跑；本轮没有派发任何任务。"
      : input.outcome === "cancelled"
        ? "本轮已取消；没有派发任何任务。"
        : "本轮答复已完成；若需要派发任务，请通过任务提案流程确认。",
  };
}
