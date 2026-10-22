/**
 * SUM-02-01/02（2026-10-22）：**计量适配端口**与**本轮选入规划**（不裁剪存档）。
 *
 * 卡内判据：
 * - SUM-02-01：计量适配端口与来源 schema，**区分 Provider / 模型 / tokenizer / 序列化版本**，
 *   **未知时保守估算**；「无统一字符/token 准确性声明」「无隐式联网计量」；
 * - SUM-02-02：完整请求计量与包装/输出预留，**选入完整记录**，模型切换**重新计量**；
 *   「只分页/调整本轮选入内容，**不裁剪存档摘要**；全局 4096 可调规则保持；必要约束放不下则 blocked/拆分」。
 *
 * 纪律（防"看起来像"）：
 * 1. 估算一律**显式标注** `basis:"estimated"` 并给出估算规则；不得宣称"准确 token"；
 * 2. **未知来源**（无 tokenizer）⇒ **保守放大**（上界估计），不是拍脑袋取精确值；
 * 3. **不联网**：端口只接受本地注入的 tokenizer 描述，缺失即估算；
 * 4. **不裁剪存档**：分页只决定"本轮选入哪些记录"，返回的 `selectedRecords` 是**完整记录引用**；
 * 5. 放不下 ⇒ `blocked` 或 `split-plan`（明确说明），**不静默截断**。
 */

/** 计量来源 schema（PROV-01 的边界最小子集）。 */
export interface SummaryMeteringSource {
  readonly providerIdentifier: string;
  readonly modelIdentifier: string;
  readonly modelVersionIdentifier: string;
  /** tokenizer 标识；未知必须写 `"unknown"`（不得留空冒充已知）。 */
  readonly tokenizerIdentifier: string;
  /** 序列化/协议版本（消息格式影响计量）。 */
  readonly serializationVersion: string;
}

/** 计量结果。 */
export type SummaryTokenMeasurement =
  | {
      readonly kind: "measured";
      readonly tokenCount: number;
      readonly basis: "tokenizer";
      readonly source: SummaryMeteringSource;
    }
  | {
      readonly kind: "estimated";
      readonly tokenCount: number;
      readonly basis: "estimated";
      readonly estimationRule: string;
      readonly isConservativeUpperBound: true;
      readonly source: SummaryMeteringSource;
    };

/** 注入的计量端口（本地 tokenizer；缺省 ⇒ 只能估算）。 */
export interface SummaryTokenizerPort {
  readonly tokenizerIdentifier: string;
  readonly serializationVersion: string;
  countTokens(text: string): number;
}

/**
 * 计量一段文本。
 *
 * 估算规则（**保守上界**）：以"字符数 / 2"作为上界（经验上多数 tokenizer 对中英文混合
 * 均不超过 1 token/2 字符；对 ASCII 亦偏保守），并**显式标注**为估算。
 * 这不是准确性声明，只是"宁可多留预算"的下限保护。
 */
export function measureSummaryText(input: {
  readonly text: string;
  readonly source: SummaryMeteringSource;
  readonly tokenizer?: SummaryTokenizerPort | null;
}): SummaryTokenMeasurement {
  const tokenizer = input.tokenizer ?? null;
  if (
    tokenizer !== null &&
    tokenizer.tokenizerIdentifier === input.source.tokenizerIdentifier &&
    tokenizer.serializationVersion === input.source.serializationVersion
  ) {
    return {
      kind: "measured",
      tokenCount: tokenizer.countTokens(input.text),
      basis: "tokenizer",
      source: input.source,
    };
  }
  const conservativeUpperBound = Math.ceil(input.text.length / 2);
  return {
    kind: "estimated",
    tokenCount: conservativeUpperBound,
    basis: "estimated",
    estimationRule:
      tokenizer === null
        ? "无 tokenizer（或未注入）：按字符数/2 保守上界估算，不宣称准确 token。"
        : "注入的 tokenizer 与来源 schema 不一致（" +
          tokenizer.tokenizerIdentifier +
          " vs " +
          input.source.tokenizerIdentifier +
          "）：按字符数/2 保守上界估算。",
    isConservativeUpperBound: true,
    source: input.source,
  };
}

/** 存档摘要的一条记录（**只读**；选入不改变存档）。 */
export interface SummaryArchiveRecord {
  readonly recordIdentifier: string;
  readonly chunkIdentifier: string;
  readonly text: string;
  readonly isPinned?: boolean;
}

/** 选入计划。 */
export type SummarySelectionPlan =
  | {
      readonly kind: "selected";
      readonly selectedRecords: ReadonlyArray<SummaryArchiveRecord>;
      readonly reservedOutputTokenCount: number;
      readonly usedInputTokenCount: number;
      readonly totalTokenCount: number;
      readonly measurementBases: ReadonlyArray<"tokenizer" | "estimated">;
    }
  | {
      readonly kind: "blocked";
      readonly reasonCode: "budget-too-small-for-pinned-records" | "single-record-exceeds-budget";
      readonly reason: string;
    }
  | {
      readonly kind: "split-plan";
      readonly reason: string;
      readonly pageSizeHint: number;
    };

/**
 * 规划"本轮选入"。
 *
 * - **只选入完整记录**（不切半条）；
 * - **不裁剪存档**（本函数纯函数，不修改输入；返回的是引用）；
 * - 预留输出预算（默认全局 4096 规则由调用方传入）；
 * - 放不下 ⇒ `blocked`（若单条或 pinned 记录超预算）或 `split-plan`（建议拆页）。
 */
export function planSummarySelection(input: {
  readonly records: ReadonlyArray<SummaryArchiveRecord>;
  /** 本轮可用输入预算（token；默认由全局 4096 规则给）。 */
  readonly inputTokenBudget: number;
  /** 需要为输出预留的 token（默认 512）。 */
  readonly outputTokenReservation?: number;
  readonly source: SummaryMeteringSource;
  readonly tokenizer?: SummaryTokenizerPort | null;
}): SummarySelectionPlan {
  const outputReservation = input.outputTokenReservation ?? 512;
  const availableInput = input.inputTokenBudget - outputReservation;
  if (availableInput <= 0) {
    return {
      kind: "blocked",
      reasonCode: "budget-too-small-for-pinned-records",
      reason:
        "可用输入预算不足（" +
        String(input.inputTokenBudget) +
        " ≤ 输出预留 " +
        String(outputReservation) +
        "）：不静默裁剪，请提高预算或改拆页。",
    };
  }

  const measurements = input.records.map((record) => ({
    record,
    measurement: measureSummaryText({
      text: record.text,
      source: input.source,
      tokenizer: input.tokenizer ?? null,
    }),
  }));

  // 单条超出可用预算（且无法拆分记录内部）⇒ blocked
  const oversized = measurements.find(
    (entry) => entry.measurement.tokenCount > availableInput && entry.record.isPinned === true,
  );
  if (oversized !== undefined) {
    return {
      kind: "blocked",
      reasonCode: "single-record-exceeds-budget",
      reason:
        "记录 " +
        oversized.record.recordIdentifier +
        " 需要 " +
        String(oversized.measurement.tokenCount) +
        " tokens，超过可用输入预算 " +
        String(availableInput) +
        "：不截断记录，请拆页。",
    };
  }

  const selectedRecords: SummaryArchiveRecord[] = [];
  let used = 0;
  for (const entry of measurements) {
    if (entry.measurement.tokenCount > availableInput) continue;
    if (used + entry.measurement.tokenCount > availableInput) continue;
    selectedRecords.push(entry.record);
    used += entry.measurement.tokenCount;
  }

  if (selectedRecords.length === 0) {
    return {
      kind: "split-plan",
      reason:
        "没有能完整放入本轮预算的记录（" +
        String(input.records.length) +
        " 条）：建议按页码拆分，不要截断记录。",
      pageSizeHint: 1,
    };
  }

  return {
    kind: "selected",
    selectedRecords,
    reservedOutputTokenCount: outputReservation,
    usedInputTokenCount: used,
    totalTokenCount: used + outputReservation,
    measurementBases: [...new Set(measurements.map((entry) => entry.measurement.basis))],
  };
}

/** 模型切换后**重新计量**（历史不重写，只重算本轮）。 */
export function remeasureAfterModelSwitch(input: {
  readonly text: string;
  readonly previousSource: SummaryMeteringSource;
  readonly nextSource: SummaryMeteringSource;
  readonly tokenizer?: SummaryTokenizerPort | null;
}): {
  readonly previous: SummaryTokenMeasurement;
  readonly next: SummaryTokenMeasurement;
  readonly isRemeasured: boolean;
  readonly notice: string;
} {
  const previous = measureSummaryText({
    text: input.text,
    source: input.previousSource,
    tokenizer: input.tokenizer ?? null,
  });
  const next = measureSummaryText({
    text: input.text,
    source: input.nextSource,
    tokenizer: input.tokenizer ?? null,
  });
  const isRemeasured =
    previous.source.modelIdentifier !== next.source.modelIdentifier ||
    previous.tokenCount !== next.tokenCount;
  return {
    previous,
    next,
    isRemeasured,
    notice: isRemeasured
      ? "模型/计量来源已变化：**只重算本轮选入**，历史摘要与存档不重写。"
      : "模型未变化：沿用既有计量。",
  };
}
