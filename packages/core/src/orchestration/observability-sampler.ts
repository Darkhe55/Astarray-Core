/**
 * OBS 采样器（2026-10-19 R39）：把 R37 的采集契约接到**真正的采样动作**上。
 *
 * 用户 2026-10-19 决策（按推荐）：默认 off、每进程 ≥5s、10MB 预算、**只采进程内指标**、
 * 观测故障**降级并报告、不阻塞业务**。
 *
 * 设计要点：
 * - **端口注入**：指标读取与时钟都由调用方注入（生产用 `process.memoryUsage`/`perf_hooks`，
 *   测试用固定值）⇒ 本模块**不直接调 OS**、也不引入不可测的全局状态；
 * - **不阻塞业务**：`store.append` 失败 ⇒ 记 `droppedSampleCount` 并返回 `degraded`，
 *   **绝不抛给调用方**；
 * - **unknown 不记作零**：拿不到某项指标时**省略该字段**（而不是填 0）；
 * - 只采集白名单四项（RSS / 事件循环延迟 / 任务时长 / 队列深度），OS 级指标一律不出现在这里。
 */
import {
  buildPerfSample,
  evaluatePerfCollection,
  type PerfSampleField,
} from "./observability-collection-contract.js";

/** 采样器输入端口（可由生产代码或测试注入）。 */
export interface PerfSamplingPorts {
  /** 进程内指标：拿不到就省略该字段（不得填 0 冒充已知）。 */
  readonly readProcessMetrics: () => Partial<Record<PerfSampleField, number>>;
  /** 当前时间（ISO）。 */
  readonly readNowIso: () => string;
  /** 本进程 PID（用于把样本归属到进程）。 */
  readonly readProcessIdentifier: () => number;
  /** 落盘端口：失败**不得**抛给业务。 */
  readonly appendSample: (sample: {
    readonly schemaVersion: 1;
    readonly sampledAtIso: string;
    readonly processIdentifier: number;
    readonly agentInstanceIdentifier: string | null;
    readonly fields: Readonly<Partial<Record<PerfSampleField, number>>>;
    readonly droppedSampleCount: number;
  }) => Promise<void>;
}

/** 一次采样 tick 的结论。 */
export type PerfSamplingTickOutcome =
  | { readonly kind: "sampled"; readonly droppedSampleCount: number; readonly reason: string }
  | {
      readonly kind: "skipped";
      readonly reasonCode: string;
      readonly reason: string;
      readonly droppedSampleCount: number;
    }
  | {
      readonly kind: "degraded";
      readonly reason: string;
      readonly droppedSampleCount: number;
    };

/**
 * 执行一次采样 tick。
 *
 * 次序：契约门禁（R37）→ 读指标 → 组样本（白名单校验）→ 落盘（失败即降级并累计丢样）。
 */
export async function runPerfSamplingTick(input: {
  readonly ports: PerfSamplingPorts;
  readonly isCollectionEnabled: boolean;
  readonly lastSampleAtIso: string | null;
  readonly storageBytesUsed: number;
  readonly agentInstanceIdentifier: string | null;
  readonly previousDroppedSampleCount?: number;
  readonly minimumSampleIntervalSeconds?: number;
  readonly storageBudgetBytes?: number;
  /** 由调用方提供的"任务耗时/队列深度"（本 tick 观测到的业务事实）。 */
  readonly taskFacts?: Readonly<Partial<Record<PerfSampleField, number>>>;
}): Promise<PerfSamplingTickOutcome> {
  const previousDroppedSampleCount = input.previousDroppedSampleCount ?? 0;
  const nowIso = input.ports.readNowIso();

  const decision = evaluatePerfCollection({
    isCollectionEnabled: input.isCollectionEnabled,
    lastSampleAtIso: input.lastSampleAtIso,
    nowIso,
    storageBytesUsed: input.storageBytesUsed,
    ...(input.storageBudgetBytes === undefined
      ? {}
      : { storageBudgetBytes: input.storageBudgetBytes }),
    ...(input.minimumSampleIntervalSeconds === undefined
      ? {}
      : { minimumSampleIntervalSeconds: input.minimumSampleIntervalSeconds }),
  });
  if (decision.kind === "skip") {
    return {
      kind: "skipped",
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      droppedSampleCount: previousDroppedSampleCount,
    };
  }

  let fields: Partial<Record<PerfSampleField, number>>;
  try {
    fields = { ...input.ports.readProcessMetrics(), ...(input.taskFacts ?? {}) };
  } catch (error) {
    return {
      kind: "degraded",
      reason: `读取进程内指标失败（已降级，不阻塞业务）：${error instanceof Error ? error.message : String(error)}`,
      droppedSampleCount: previousDroppedSampleCount + 1,
    };
  }

  const built = buildPerfSample({
    sampledAtIso: nowIso,
    processIdentifier: input.ports.readProcessIdentifier(),
    agentInstanceIdentifier: input.agentInstanceIdentifier,
    fields: fields as Record<string, unknown>,
    droppedSampleCount: previousDroppedSampleCount,
  });
  if (built.kind === "rejected") {
    return {
      kind: "degraded",
      reason: `采样被拒绝（已降级，不阻塞业务）：${built.reason}`,
      droppedSampleCount: previousDroppedSampleCount + 1,
    };
  }

  try {
    await input.ports.appendSample(built.sample);
  } catch (error) {
    return {
      kind: "degraded",
      reason: `样本落盘失败（已降级，不阻塞业务）：${error instanceof Error ? error.message : String(error)}`,
      droppedSampleCount: previousDroppedSampleCount + 1,
    };
  }

  return {
    kind: "sampled",
    droppedSampleCount: previousDroppedSampleCount,
    reason: "已按契约采样并落盘。",
  };
}

/**
 * ## 为什么这里不提供"生产默认端口"（如实说明）
 *
 * 进程样本（RSS / 事件循环延迟 / 队列深度）与既有 `PerfSampleEvent` 的字段并不重合：
 * 后者要求 `operationKind` + `durationMilliseconds`（**业务样本**语义），
 * 而进程样本没有"耗时"，硬填 0 就违反卡内"unknown 不记作零"。
 *
 * ⇒ 若要真正落盘进程样本，需要**新增一种事件类型或独立文件**（属于数据 schema 决策）。
 * 本轮只交付**可测的 tick 逻辑**：由调用方注入端口（指标读取/时钟/PID/落盘），
 * 生产接线在 schema 决定后进行。**不主张"采样已上线"**。
 */
