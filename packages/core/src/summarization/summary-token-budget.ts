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
 * 估算规则（**上界**）：用户 2026-10-22 决定 —— 直接以**字符数本身**作为上界，并显式标注为估算。
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
  // 用户口径（2026-10-22）：**字符数本身作为上界**（不是字符数/2）。
  const conservativeUpperBound = input.text.length;
  return {
    kind: "estimated",
    tokenCount: conservativeUpperBound,
    basis: "estimated",
    estimationRule:
      tokenizer === null
        ? "无 tokenizer（或未注入）：按**字符数本身**作为上界估算，不宣称准确 token。"
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
      readonly kind: "split-plan";
      /** 首页可完整放下的记录（不放宽预算、不裁剪记录）。 */
      readonly firstPageRecords: ReadonlyArray<SummaryArchiveRecord>;
      readonly pageSizeHint: number;
      readonly remainingRecordCount: number;
      readonly usedInputTokenCount: number;
      readonly reason: string;
    }
  | {
      readonly kind: "blocked";
      readonly reasonCode: "budget-too-small-for-pinned-records" | "single-record-exceeds-budget";
      readonly reason: string;
    };

/**
 * 规划"本轮选入"。
 *
 * - **只选入完整记录**（不切半条）；
 * - **不裁剪存档**（本函数纯函数，不修改输入；返回的是引用）；
 * - 预留输出预算（默认全局 4096 规则由调用方传入）；
 * - 放不下 ⇒ `blocked`（若单条或 pinned 记录超预算）或 `split-plan`（建议拆页）。
 */
/**
 * 规划"本轮选入"。
 *
 * 用户口径（2026-10-22）：**放不下就拆页**——返回首页可完整放下的记录 + 剩余条数，
 * **不静默丢弃、不裁剪存档、不放宽预算**。
 * 单条 pinned 记录超出可用预算 ⇒ `blocked`（不截断记录）。
 */
export function planSummarySelection(input: {
  readonly records: ReadonlyArray<SummaryArchiveRecord>;
  readonly inputTokenBudget: number;
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
        "）：不静默裁剪，请提高预算或拆页。",
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

  const oversizedPinned = measurements.find(
    (entry) => entry.measurement.tokenCount > availableInput && entry.record.isPinned === true,
  );
  if (oversizedPinned !== undefined) {
    return {
      kind: "blocked",
      reasonCode: "single-record-exceeds-budget",
      reason:
        "记录 " +
        oversizedPinned.record.recordIdentifier +
        " 需要 " +
        String(oversizedPinned.measurement.tokenCount) +
        " tokens，超过可用输入预算 " +
        String(availableInput) +
        "：不截断记录，请拆页。",
    };
  }

  const firstPageRecords: SummaryArchiveRecord[] = [];
  let used = 0;
  for (const entry of measurements) {
    if (entry.measurement.tokenCount > availableInput) continue;
    if (used + entry.measurement.tokenCount > availableInput) break;
    firstPageRecords.push(entry.record);
    used += entry.measurement.tokenCount;
  }

  const measurementBases = [...new Set(measurements.map((entry) => entry.measurement.basis))];

  if (firstPageRecords.length === input.records.length) {
    return {
      kind: "selected",
      selectedRecords: firstPageRecords,
      reservedOutputTokenCount: outputReservation,
      usedInputTokenCount: used,
      totalTokenCount: used + outputReservation,
      measurementBases,
    };
  }

  if (firstPageRecords.length === 0) {
    return {
      kind: "split-plan",
      firstPageRecords: [],
      pageSizeHint: 1,
      remainingRecordCount: input.records.length,
      usedInputTokenCount: 0,
      reason:
        "没有能完整放入本轮预算的记录（" +
        String(input.records.length) +
        " 条）：必须拆页，不要截断记录。",
    };
  }

  return {
    kind: "split-plan",
    firstPageRecords,
    pageSizeHint: firstPageRecords.length,
    remainingRecordCount: input.records.length - firstPageRecords.length,
    usedInputTokenCount: used,
    reason:
      "本轮预算只能完整放入 " +
      String(firstPageRecords.length) +
      " 条，其余 " +
      String(input.records.length - firstPageRecords.length) +
      " 条**拆页**继续（不裁剪存档、不静默丢弃）。",
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
