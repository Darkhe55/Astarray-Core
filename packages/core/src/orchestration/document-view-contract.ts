/**
 * DOCVIEW-01-01（2026-10-01 卡，2026-10-18 R17）：**格式适配的内容优先读取**的契约层。
 *
 * 卡内依据（`docs/tasks/2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS.md` §2）：
 * - 提供 `presentationMode: content | structure | layout`，**默认 content**；用**枚举**而不是
 *   多个可能冲突的布尔参数；
 * - `content` 省略字体/字号/边距/颜色等**纯展示属性**；`structure` 补标题层级/列表/表格单元格/
 *   链接/脚注/代码块/公式/分区定位；`layout` 仅在排版/视觉审查时补读必要布局属性或预览；
 * - **内容优先不是无结构纯文本**：标题、阅读顺序、表头与单元格关系、公式、单位、否定、
 *   批注/修订状态**不能静默丢失**；删除线/颜色承担语义时**保留语义提示**，无法判断时**标不确定并允许展开**；
 * - 每次返回标注**源版本、原页/段/区域锚点、视图模式、省略类型及已知损失**；
 *   **过滤视图不可直接作为完整文件覆盖写回**；不同视图**缓存隔离**；
 * - 首期验收 文本/Markdown/HTML/DOCX；PDF 只支持可可靠提取文本的文档，
 *   扫描件/复杂多栏**不伪报已完整读取**；LaTeX/前端源码**不执行宏、脚本或外链**。
 *
 * ## 边界
 * 纯判定：不解析文件、不渲染、不执行宏/脚本、不写回。只回答"该模式能提供什么、丢了什么、能否写回"。
 */
import { createHash } from "node:crypto";

/** 呈现模式（枚举，默认 content）。 */
export type DocumentPresentationMode = "content" | "structure" | "layout";

/** 首期承诺的格式。 */
export type DocumentFormatKind = "text" | "markdown" | "html" | "docx" | "pdf";

/** 省略类别（用于"已知损失"如实报告）。 */
export type DocumentOmittedCategory =
  | "font-family"
  | "font-size"
  | "margins"
  | "colors"
  | "page-layout"
  | "style-tree"
  | "images"
  | "scanned-content";

/** 视图回执（卡内要求的来源与损失标注）。 */
export interface DocumentViewReceiptV1 {
  readonly schemaVersion: 1;
  readonly format: DocumentFormatKind;
  readonly presentationMode: DocumentPresentationMode;
  readonly sourceRevision: string;
  /** 原页/段/区域锚点（至少一个，用于定位与补读）。 */
  readonly sourceAnchors: ReadonlyArray<string>;
  readonly omittedCategories: ReadonlyArray<DocumentOmittedCategory>;
  /** 已知损失说明（人可读）。 */
  readonly knownLosses: ReadonlyArray<string>;
  /** 语义可能有损（如删除线/颜色承担含义）⇒ 必须标不确定并允许展开。 */
  readonly mustMarkUncertain: boolean;
  readonly isExpandable: boolean;
  /** **过滤视图不可直接作为完整文件覆盖写回**（恒 false）。 */
  readonly isFullFileWriteBackAllowed: false;
  /** 不执行宏/脚本/外链（恒 false）。 */
  readonly executesMacrosOrScripts: false;
  readonly cacheKey: string;
}

/** 解析 argv/调用方给出的模式；未知值 ⇒ null（不猜）。 */
export function resolveDocumentPresentationMode(
  rawMode: string | undefined,
): DocumentPresentationMode | null {
  if (rawMode === undefined) return "content";
  if (rawMode === "content" || rawMode === "structure" || rawMode === "layout") return rawMode;
  return null;
}

/** 各格式 × 模式的可用性（首期）。 */
export function evaluateDocumentViewCapability(input: {
  readonly format: DocumentFormatKind;
  readonly presentationMode: DocumentPresentationMode;
  /** PDF 是否为扫描件/复杂多栏（无法可靠提取文本）。 */
  readonly isPdfReliablyExtractable?: boolean;
}): { readonly isSupported: boolean; readonly reason: string } {
  if (input.format === "pdf" && input.isPdfReliablyExtractable === false) {
    return {
      isSupported: false,
      reason: "PDF 无法可靠提取文本（扫描件/复杂多栏）：如实报告不支持，不伪报已完整读取。",
    };
  }
  // DOCX/PDF 的 layout 只承诺"按页/区域补读必要布局属性或预览"，不默认导出完整样式树
  if (input.presentationMode === "layout" && (input.format === "docx" || input.format === "pdf")) {
    return {
      isSupported: true,
      reason: "layout 仅补读必要布局属性/预览，不导出完整样式树。",
    };
  }
  return { isSupported: true, reason: "首期支持该格式与模式。" };
}

/** 各模式默认省略的类别（content 省略纯展示属性；structure/layout 逐步补回）。 */
export function listDefaultOmittedCategories(
  presentationMode: DocumentPresentationMode,
): ReadonlyArray<DocumentOmittedCategory> {
  if (presentationMode === "content") {
    return ["font-family", "font-size", "margins", "colors", "page-layout", "style-tree"];
  }
  if (presentationMode === "structure") {
    return ["font-family", "font-size", "style-tree"];
  }
  // layout：仅省略完整样式树（其余按需补读）
  return ["style-tree"];
}

/**
 * 生成视图回执。
 *
 * - 缺源版本或锚点 ⇒ 拒绝（无法定位/无法证明看的是哪一版）；
 * - `content` 模式必须报告"纯展示属性被省略"这一已知损失；
 * - 语义可能受损（删除线/颜色/修订状态）⇒ `mustMarkUncertain:true` 且 `isExpandable:true`；
 * - 任何模式都**不可**直接覆盖写回，且**不执行**宏/脚本/外链。
 */
export function buildDocumentViewReceipt(input: {
  readonly format: DocumentFormatKind;
  readonly presentationMode: DocumentPresentationMode;
  readonly sourceRevision: string;
  readonly sourceAnchors: ReadonlyArray<string>;
  readonly hasSemanticFormatting?: boolean;
  readonly additionalOmittedCategories?: ReadonlyArray<DocumentOmittedCategory>;
}): { readonly kind: "built"; readonly receipt: DocumentViewReceiptV1 } | {
  readonly kind: "rejected";
  readonly reason: string;
} {
  if (input.sourceRevision.trim() === "") {
    return { kind: "rejected", reason: "缺少源版本：无法证明查看的是哪一版。" };
  }
  if (input.sourceAnchors.length === 0 || input.sourceAnchors.some((anchor) => anchor.trim() === "")) {
    return { kind: "rejected", reason: "缺少原页/段/区域锚点：无法定位与补读。" };
  }
  const omittedCategories = [
    ...new Set([
      ...listDefaultOmittedCategories(input.presentationMode),
      ...(input.additionalOmittedCategories ?? []),
    ]),
  ];
  const knownLosses =
    input.presentationMode === "content"
      ? ["已省略字体/字号/边距/颜色等纯展示属性（正文与阅读顺序保留）。"]
      : input.presentationMode === "structure"
        ? ["已省略字体/字号与完整样式树；结构与语义已保留。"]
        : ["已省略完整样式树；按页/区域补读必要布局属性。"];
  const hasSemanticFormatting = input.hasSemanticFormatting === true;
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify([
        input.format,
        input.presentationMode,
        input.sourceRevision,
        [...input.sourceAnchors].sort(),
      ]),
    )
    .digest("hex");

  return {
    kind: "built",
    receipt: {
      schemaVersion: 1,
      format: input.format,
      presentationMode: input.presentationMode,
      sourceRevision: input.sourceRevision,
      sourceAnchors: input.sourceAnchors,
      omittedCategories,
      knownLosses: hasSemanticFormatting
        ? [...knownLosses, "存在承担语义的格式（删除线/颜色/修订状态）：已保留语义提示并标记不确定，可展开。"]
        : knownLosses,
      mustMarkUncertain: hasSemanticFormatting,
      isExpandable: true,
      isFullFileWriteBackAllowed: false,
      executesMacrosOrScripts: false,
      cacheKey,
    },
  };
}

/**
 * 过滤视图能否直接覆盖写回原文件。
 *
 * 卡内明令：**不可**。恒返回 false —— 任何"用过滤视图写回"的提议都必须先做完整原文读取，
 * 且走既有破坏性变更的备份流程。
 */
export function canWriteBackFromFilteredView(): false {
  return false;
}

/**
 * 排版/样式细节是否应在本任务中被读取。
 *
 * 卡内：**普通内容任务不读取样式详情，排版任务可显式展开**。
 */
export function shouldReadStyleDetails(input: {
  readonly taskKind: "content" | "layout-review";
  readonly presentationMode: DocumentPresentationMode;
}): boolean {
  return input.taskKind === "layout-review" && input.presentationMode === "layout";
}
