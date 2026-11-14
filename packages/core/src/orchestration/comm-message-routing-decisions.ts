/**
 * COMM-01 语义决策的**纯判定层**（2026-11-14，用户给定口径）。
 *
 * 用户三条裁决（逐字要点，实现必须与之一致）：
 * 1. **回复路由**：agent 执行任务期间标记当前任务 id；该期间发出的任务回复**直接使用该任务 id
 *    对应的原路径**，而不是该 agent 可能正在使用的对话/传呼对象。
 * 2. **重放**：**静默去重**，返回原结果，并在结果中带**重复次数标记**。
 * 3. **迟到/乱序**：同一 agent 会收到分属不同任务意图的消息序列，可能重叠/易混，
 *    且同一序列可能**不连续**（中间插入其它内容）⇒ 装配上下文时必须按"是否同一事实"分开，
 *    只有确实同属一个事实的内容才能合并送给模型。
 *
 * 本文件只做判定，不投递、不落盘、不调模型。
 */
import { DomainError } from "../core/errors.js";

/** 一条已投递过的消息记录（用于重放去重）。 */
export interface DeliveredMessageRecord {
  readonly messageIdentifier: string;
  /** 首次投递时的结果载荷（去重时原样返回）。 */
  readonly originalResult: unknown;
  readonly deliveredAtIso: string;
  /** 该 messageIdentifier 已出现的次数（含首次）。 */
  readonly occurrenceCount: number;
}

export interface ReplayDedupeOutcome {
  readonly isDuplicate: boolean;
  /** 重复时返回**首次**结果；首次投递时为本次结果。 */
  readonly result: unknown;
  /** 含首次在内的总出现次数；如实标注，不隐藏重复。 */
  readonly occurrenceCount: number;
}

/**
 * 重放去重：**静默**（不抛错、不告警）返回原结果，并带重复次数。
 *
 * 明确不做的事：不把重复当成错误、不合并成"新结果"、不丢失首次结果。
 */
export function dedupeReplayedMessage(input: {
  readonly messageIdentifier: string;
  readonly existingRecord: DeliveredMessageRecord | null;
  readonly incomingResult: unknown;
  readonly deliveredAtIso: string;
}): { readonly outcome: ReplayDedupeOutcome; readonly recordToStore: DeliveredMessageRecord } {
  if (input.messageIdentifier.trim() === "") {
    throw new DomainError("invalid-task-chain", "消息标识不能为空（重放去重需要稳定键）");
  }
  if (input.existingRecord === null) {
    return {
      outcome: {
        isDuplicate: false,
        result: input.incomingResult,
        occurrenceCount: 1,
      },
      recordToStore: {
        messageIdentifier: input.messageIdentifier,
        originalResult: input.incomingResult,
        deliveredAtIso: input.deliveredAtIso,
        occurrenceCount: 1,
      },
    };
  }
  const nextOccurrenceCount = input.existingRecord.occurrenceCount + 1;
  return {
    outcome: {
      isDuplicate: true,
      result: input.existingRecord.originalResult,
      occurrenceCount: nextOccurrenceCount,
    },
    recordToStore: {
      ...input.existingRecord,
      occurrenceCount: nextOccurrenceCount,
    },
  };
}

/** 回复路由上下文：agent 当前在哪个任务里、想用哪个通信对象回复。 */
export interface TaskReplyRoutingInput {
  /** agent 执行期间标记的当前任务（缺省表示"当前不在任务里"）。
   * 注意：是**任务标识**，不是会话/通信对象。 */
  readonly currentTaskIdentifier: string | null;
  /** 回复打算走的通信对象（对话、传呼、其它 agent）。 */
  readonly communicatorIdentifier: string | null;
  /** 该任务登记过的原路径标识（用于核对"回的是不是原路"）。 */
  readonly boundReplyPathIdentifier: string | null;
}

export type TaskReplyRoutingDecision =
  | {
      readonly kind: "route-through-bound-path";
      readonly pathIdentifier: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: string;
    };

/**
 * 回复路由：**任务期间必须走该任务绑定的原路径**。
 *
 * 关键反例（卡内 L71 明令禁止）：不得按"最近对话对象"/当前通信工具对象推断收件人。
 * 因此没有当前任务、或任务没有绑定原路径时，一律**拒绝**而不是猜。
 */
export function resolveTaskReplyRouting(
  input: TaskReplyRoutingInput,
): TaskReplyRoutingDecision {
  if (input.currentTaskIdentifier === null) {
    return {
      kind: "refused",
      reason: "当前不在任务执行期间：不得按通信对象推断任务回复路径",
    };
  }
  if (input.boundReplyPathIdentifier === null) {
    return {
      kind: "refused",
      reason: `任务 ${input.currentTaskIdentifier} 未登记原回复路径：拒绝按通信对象 ${String(
        input.communicatorIdentifier,
      )} 回复`,
    };
  }
  return {
    kind: "route-through-bound-path",
    pathIdentifier: input.boundReplyPathIdentifier,
  };
}

/** 待装配的一条消息（来自某个 agent 的某个任务序列）。 */
export interface PendingAssemblyMessage {
  readonly messageIdentifier: string;
  readonly sourceTaskIdentifier: string;
  /** 序列标识：同一序列的消息可能被其它内容打断，不能靠相邻性判断。 */
  readonly sequenceIdentifier: string;
  /** 该消息是否已被确认与序列中其它消息属于**同一事实**。 */
  readonly isSameFactAsSequence: boolean;
  readonly text: string;
}

export interface AssemblyGroup {
  readonly sourceTaskIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly messageIdentifiers: readonly string[];
  readonly combinedText: string;
}

/**
 * 上下文装配：**只有确实同属一个事实**的内容才合并。
 *
 * 用户口径要点：
 * - 同一 agent 会收到**分属不同任务意图**的序列 ⇒ 按 `sourceTaskIdentifier` 分开；
 * - 同一序列的消息**可能被插入内容打断** ⇒ 分组**不依赖相邻性**，只按"同任务 + 同序列"聚合；
 * - 尚未确认"同一事实"的消息**不得**合并（宁可分开，不许猜合并）。
 */
export function groupMessagesForAssembly(
  messages: readonly PendingAssemblyMessage[],
): { readonly groups: readonly AssemblyGroup[]; readonly unmergedMessageIdentifiers: readonly string[] } {
  const groups = new Map<string, PendingAssemblyMessage[]>();
  const unmergedMessageIdentifiers: string[] = [];
  for (const message of messages) {
    if (!message.isSameFactAsSequence) {
      unmergedMessageIdentifiers.push(message.messageIdentifier);
      continue;
    }
    const groupKey = `${message.sourceTaskIdentifier}\u0000${message.sequenceIdentifier}`;
    const bucket = groups.get(groupKey);
    if (bucket === undefined) {
      groups.set(groupKey, [message]);
      continue;
    }
    bucket.push(message);
  }
  return {
    groups: [...groups.values()].map((bucket) => ({
      sourceTaskIdentifier: bucket[0]!.sourceTaskIdentifier,
      sequenceIdentifier: bucket[0]!.sequenceIdentifier,
      messageIdentifiers: bucket.map((message) => message.messageIdentifier),
      combinedText: bucket.map((message) => message.text).join("\n"),
    })),
    unmergedMessageIdentifiers,
  };
}
