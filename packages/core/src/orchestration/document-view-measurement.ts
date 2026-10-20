/**
 * DOCVIEW-01-03（2026-10-20）：**计量与语义覆盖**。
 *
 * 卡内要求：对同一文档测 **返回字节 / token / 峰值内存 / 读取耗时 / 关键语义覆盖**，
 * 并明确「**不把长度下降等同准确性提升**」。
 *
 * 为什么单独成模块：
 * - 计量必须是**纯函数**（除了调用方传入的耗时），否则"方便地顺手读一次盘"就会污染测量；
 * - 语义覆盖必须**同时**给出「原文里有多少」与「提取后保留多少」，只报后者等于自证清白；
 * - token 一律标注为**估算**（字符/4），不假装是真 tokenizer —— 这点不写清就会被当成真实账单。
 */
import type { DocumentExtractionResult } from "./document-view-adapter.js";

/** 语义类别（卡内点名：标题、表格单元格、脚注、公式、修订、隐藏内容）。 */
export type DocumentSemanticCategory =
  | "headings"
  | "table-cells"
  | "footnotes"
  | "formulas"
  | "revisions"
  | "hidden-content";

/** 单类语义的覆盖情况。 */
export interface DocumentSemanticCoverageEntry {
  readonly category: DocumentSemanticCategory;
  /** 原文中的标记数量（"应该保留多少"）。 */
  readonly expectedCount: number;
  /** 提取结果里实际保留的数量。 */
  readonly preservedCount: number;
  /** 是否完全覆盖（少一个就是 false，不四舍五入）。 */
  readonly isComplete: boolean;
}

/** 一次抽取的计量结果。 */
export interface DocumentViewMeasurement {
  readonly fileName: string;
  readonly format: string | null;
  readonly kind: DocumentExtractionResult["kind"];
  /** 原文 UTF-8 字节数。 */
  readonly sourceBytes: number;
  /** 提取结果（所有块文本 + 空白分隔）的 UTF-8 字节数。 */
  readonly extractedBytes: number;
  /**
   * **token 估算** = 字符数 / 4（仅标注量级用）。
   * 不接真实 tokenizer：不同模型口径不同，报成"真实 token"就是虚报。
   */
  readonly tokenEstimate: number;
  readonly tokenEstimateBasis: "characters/4-estimate";
  readonly blockCount: number;
  readonly degradedBlockCount: number;
  readonly knownLossCount: number;
  readonly isTruncated: boolean;
  readonly coverage: ReadonlyArray<DocumentSemanticCoverageEntry>;
  readonly isSemanticCoverageComplete: boolean;
  /** 调用方测量到的耗时（毫秒）；未提供则为 null（不编造）。 */
  readonly measurementDurationMilliseconds: number | null;
}

/** 统计 markdown 表格单元格（去掉分隔行 `---`）。 */
function countMarkdownTableCells(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
    if (cells.length === 0) continue;
    // 分隔行：全部由 - 与 : 组成
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    count += cells.length;
  }
  return count;
}

/** 统计块文本里的单元格（html 适配器把单元格拼成 " | "，markdown 保留 `|`）。 */
function countCellsInBlockText(text: string): number {
  return text
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "" && !/^:?-{2,}:?$/.test(cell)).length;
}

/** 统计 HTML 表格单元格。 */
function countHtmlTableCells(text: string): number {
  return (text.match(/<t[dh][^>]*>/gi) ?? []).length;
}

/** 统计某类别在**提取结果**里的保留数量。 */
function countPreserved(
  category: DocumentSemanticCategory,
  extraction: DocumentExtractionResult,
): number {
  switch (category) {
    case "headings":
      return extraction.blocks.filter((block) => block.kind === "heading").length;
    case "footnotes":
      return extraction.blocks.filter((block) => block.kind === "footnote").length;
    case "formulas":
      return extraction.blocks.filter((block) => block.kind === "formula").length;
    case "revisions":
      return extraction.blocks.filter((block) => block.kind === "revision").length;
    case "hidden-content":
      return extraction.blocks.filter((block) => block.kind === "hidden-content").length;
    case "table-cells":
      /**
       * 表格块的 `text` 是**人可读文本**（html 适配器已剥掉标签），
       * 因此保留数按 "|" 分隔的单元格计数；html 的 `<td>` 计数只用于原文侧。
       */
      return extraction.blocks
        .filter((block) => block.kind === "table")
        .reduce((total, block) => total + countCellsInBlockText(block.text), 0);
    default: {
      const exhaustiveCheck: never = category;
      return exhaustiveCheck;
    }
  }
}

/** 统计某类别在**原文**里的数量。 */
function countExpected(
  category: DocumentSemanticCategory,
  content: string,
  format: string | null,
): number {
  const isHtml = format === "html";
  switch (category) {
    case "headings":
      return isHtml
        ? (content.match(/<h[1-6][^>]*>/gi) ?? []).length
        : (content.match(/^#{1,6}\s+\S/gm) ?? []).length;
    case "table-cells":
      return isHtml ? countHtmlTableCells(content) : countMarkdownTableCells(content);
    case "footnotes":
      return isHtml ? 0 : (content.match(/^\[\^[^\]]+\]:/gm) ?? []).length;
    case "formulas":
      // `$$` 成对出现 ⇒ 1 个公式；奇数个标记按向上取整（未闭合公式仍是一个块）
      return isHtml ? 0 : Math.ceil((content.match(/\$\$/g) ?? []).length / 2);
    case "revisions":
      return isHtml
        ? (content.match(/<(del|s)>[\s\S]*?<\/\1>|<ins>[\s\S]*?<\/ins>/gi) ?? []).length
        : (content.match(/~~[^~]+~~/g) ?? []).length;
    case "hidden-content":
      return isHtml
        ? (content.match(/<!--[\s\S]*?-->/g) ?? []).length +
            (content.match(/display\s*:\s*none/gi) ?? []).length
        : (content.match(/<!--/g) ?? []).length;
    default: {
      const exhaustiveCheck: never = category;
      return exhaustiveCheck;
    }
  }
}

const SEMANTIC_CATEGORIES: ReadonlyArray<DocumentSemanticCategory> = [
  "headings",
  "table-cells",
  "footnotes",
  "formulas",
  "revisions",
  "hidden-content",
];

/**
 * 计量一次抽取（纯函数；耗时由调用方传入，未传入则如实标 null）。
 *
 * 注意：`expectedCount` 是**原文标记数**，`preservedCount` 是**提取后保留数**；
 * 两者都给出，避免"只报保留数"式的自证清白。
 */
export function measureDocumentExtraction(input: {
  readonly fileName: string;
  readonly content: string;
  readonly extraction: DocumentExtractionResult;
  readonly measurementDurationMilliseconds?: number;
}): DocumentViewMeasurement {
  const { extraction } = input;
  const extractedText = extraction.blocks.map((block) => block.text).join("\n\n");
  const sourceBytes = Buffer.byteLength(input.content, "utf8");
  const extractedBytes = Buffer.byteLength(extractedText, "utf8");

  const coverage = SEMANTIC_CATEGORIES.map((category) => {
    const expectedCount = countExpected(category, input.content, extraction.format);
    const preservedCount = countPreserved(category, extraction);
    return {
      category,
      expectedCount,
      preservedCount,
      // 只在"原文确实有该类内容"时才要求覆盖；没有该类别 ⇒ 视为已覆盖
      isComplete: expectedCount === 0 ? true : preservedCount >= expectedCount,
    };
  });

  return {
    fileName: input.fileName,
    format: extraction.format,
    kind: extraction.kind,
    sourceBytes,
    extractedBytes,
    tokenEstimate: Math.ceil(input.content.length / 4),
    tokenEstimateBasis: "characters/4-estimate",
    blockCount: extraction.blocks.length,
    degradedBlockCount: extraction.blocks.filter((block) => block.isDegraded).length,
    knownLossCount: extraction.knownLosses.length,
    isTruncated: extraction.isTruncated,
    coverage,
    isSemanticCoverageComplete: coverage.every((entry) => entry.isComplete),
    measurementDurationMilliseconds: input.measurementDurationMilliseconds ?? null,
  };
}


