/**
 * DOCVIEW-01-02（2026-10-20）：**首批格式适配器 + 定位回执**。
 *
 * 卡内要求（`docs/tasks/2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS.md` §2）：
 * - "实现首批适配器与定位回执；表格、脚注、修订、公式、隐藏/多栏内容、**转义**和**损坏文件**反例；不支持场景明确降级"；
 * - "标题、阅读顺序、表头与单元格关系、公式、单位、否定、批注/修订状态**不能因为省 token 而静默丢失**"；
 * - "每次返回标注**源版本**、原页/段/区域**锚点**、视图模式、**省略类型**及**已知损失**"；
 * - "过滤视图不可直接作为完整文件覆盖写回"；"不执行宏、脚本或外链"；"按页/块读取，防资源耗尽"。
 *
 * 本模块是**首批**适配器（text / markdown / html），刻意**不**包含 docx/pdf：
 * 解析二进制格式需要额外依赖与解压膨胀防护，属于后续切片；不支持时**明确报告**，不伪报已读取。
 *
 * 设计纪律：
 * 1. **纯函数**：输入文件名 + 内容文本，输出块列表与回执；不读盘、不联网、不执行任何内容；
 * 2. **静默丢失是缺陷**：表格/脚注/修订/公式/隐藏内容一律产出**块**并标 `isDegraded` + 原因；
 * 3. **损坏即报告**：NUL 字节 / 大量替换字符 ⇒ `kind:"corrupted"`，不返回半真半假的正文；
 * 4. **有界**：块数上限、单块字符上限，超出标 `isTruncated`（防资源耗尽）；
 * 5. **写回永远不允许**：`isFullFileWriteBackAllowed: false`（常量）。
 */
import { createHash } from "node:crypto";

/** 首批支持的源格式。 */
export type FirstBatchDocumentFormat = "text" | "markdown" | "html";

/** 块类别。 */
export type DocumentBlockKind =
  | "heading"
  | "paragraph"
  | "list-item"
  | "code-block"
  | "table"
  | "footnote"
  | "formula"
  | "revision"
  | "hidden-content";

/** 单个块的定位回执。 */
export interface DocumentBlockReceipt {
  readonly blockIdentifier: string;
  readonly kind: DocumentBlockKind;
  /** 1 起的阅读顺序。 */
  readonly ordinal: number;
  /** 1 起的行号区间（含端点）。 */
  readonly lineStart: number;
  readonly lineEnd: number;
  /** 块文本（已做必要的转义解码；不做任何内容执行）。 */
  readonly text: string;
  /** 稳定锚点：`<format>:line:<lineStart>` 或 `<format>:block:<ordinal>`。 */
  readonly sourceAnchor: string;
  /** 是否因能力不足而降级（表格列关系/公式渲染/修订语义等）。 */
  readonly isDegraded: boolean;
  readonly degradationReason: string | null;
  /** 语义可能不确定（如删除线/颜色承担含义）⇒ 允许展开核对。 */
  readonly mustMarkUncertain: boolean;
}

/** 提取结果。 */
export interface DocumentExtractionResult {
  readonly kind: "extracted" | "unsupported" | "corrupted";
  readonly format: FirstBatchDocumentFormat | null;
  readonly blocks: ReadonlyArray<DocumentBlockReceipt>;
  /** 已知损失（人可读；空数组表示未发现损失）。 */
  readonly knownLosses: ReadonlyArray<string>;
  readonly isTruncated: boolean;
  /** 源版本（内容 sha256，标注"读的是哪一版"）。 */
  readonly sourceRevision: string;
  /** 恒 false：过滤视图不得作为完整文件覆盖写回。 */
  readonly isFullFileWriteBackAllowed: false;
  /** 恒 false：不执行宏、脚本或外链。 */
  readonly executesMacrosOrScripts: false;
}

/** 块数上限与单块字符上限（有界，防资源耗尽）。 */
export const MAXIMUM_DOCUMENT_BLOCKS = 2_000;
export const MAXIMUM_DOCUMENT_BLOCK_CHARACTERS = 20_000;

/** 扩展名 → 首批格式（未知返回 null，交由调用方报不支持）。 */
export function detectFirstBatchDocumentFormat(
  fileName: string,
): FirstBatchDocumentFormat | null {
  const lowerCaseName = fileName.toLowerCase();
  if (lowerCaseName.endsWith(".md") || lowerCaseName.endsWith(".markdown")) return "markdown";
  if (lowerCaseName.endsWith(".html") || lowerCaseName.endsWith(".htm")) return "html";
  if (lowerCaseName.endsWith(".txt") || lowerCaseName.endsWith(".text")) return "text";
  return null;
}

/** HTML 实体解码（只解常见实体，**不**执行任何标记）。 */
function decodeHtmlEntities(input: string): string {
  const namedEntities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  let output = input;
  for (const [entity, replacement] of Object.entries(namedEntities)) {
    output = output.split(entity).join(replacement);
  }
  return output.replace(/&#(\d{1,6});/g, (_match, codePoint: string) =>
    String.fromCodePoint(Number.parseInt(codePoint, 10)),
  );
}

/** 判定损坏：含 NUL 或替换字符过多（不是"内容脏"，而是"解码不可信"）。 */
function detectCorruption(content: string): string | null {
  if (content.includes("\u0000")) {
    return "内容包含 NUL 字节：看起来是二进制文件被当作文本读取，拒绝给出正文。";
  }
  const replacementCharacterCount = (content.match(/\uFFFD/g) ?? []).length;
  if (replacementCharacterCount > 0 && replacementCharacterCount >= content.length / 50) {
    return "替换字符（U+FFFD）占比过高：字符编码可能不是 UTF-8，拒绝给出可能失真的正文。";
  }
  return null;
}

interface MutableBlock {
  kind: DocumentBlockKind;
  lineStart: number;
  lineEnd: number;
  text: string;
  isDegraded: boolean;
  degradationReason: string | null;
  mustMarkUncertain: boolean;
}

/** markdown 适配器（块级；表格/脚注/公式/删除线/注释全部产出并标注）。 */
function extractMarkdownBlocks(lines: ReadonlyArray<string>): {
  blocks: MutableBlock[];
  knownLosses: string[];
} {
  const blocks: MutableBlock[] = [];
  const knownLosses: string[] = [];
  let index = 0;
  let isInFence = false;
  let fenceStartLine = 0;
  let fenceLines: string[] = [];

  while (index < lines.length) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? "";
    const trimmedLine = rawLine.trim();

    // 围栏代码块
    if (trimmedLine.startsWith("```")) {
      if (!isInFence) {
        isInFence = true;
        fenceStartLine = lineNumber;
        fenceLines = [];
      } else {
        blocks.push({
          kind: "code-block",
          lineStart: fenceStartLine,
          lineEnd: lineNumber,
          text: fenceLines.join("\n"),
          isDegraded: false,
          degradationReason: null,
          mustMarkUncertain: false,
        });
        isInFence = false;
      }
      index += 1;
      continue;
    }
    if (isInFence) {
      fenceLines.push(rawLine);
      index += 1;
      continue;
    }

    // 隐藏内容（HTML 注释）：不静默丢弃 ⇒ 产出块并说明
    if (trimmedLine.startsWith("<!--")) {
      const startLine = lineNumber;
      let commentText = trimmedLine;
      while (!commentText.includes("-->") && index + 1 < lines.length) {
        index += 1;
        commentText += `\n${lines[index] ?? ""}`;
      }
      blocks.push({
        kind: "hidden-content",
        lineStart: startLine,
        lineEnd: index + 1,
        text: commentText,
        isDegraded: true,
        degradationReason: "隐藏/注释内容不计入正文，但已记录（不静默丢弃）。",
        mustMarkUncertain: true,
      });
      index += 1;
      continue;
    }

    if (trimmedLine === "") {
      index += 1;
      continue;
    }

    // 表格：连续的 `|` 行
    if (trimmedLine.startsWith("|")) {
      const startLine = lineNumber;
      const tableLines: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        tableLines.push((lines[index] ?? "").trim());
        index += 1;
      }
      blocks.push({
        kind: "table",
        lineStart: startLine,
        lineEnd: index,
        text: tableLines.join("\n"),
        isDegraded: true,
        degradationReason: "表格按行保留，但不保证列合并/对齐与表头关联的完整语义；需要时请按 structure 模式补读。",
        mustMarkUncertain: false,
      });
      continue;
    }

    // 公式（块级 $$...$$ 或单行 $...$）
    if (trimmedLine.startsWith("$$") || /^\$\$[\s\S]*\$\$$/.test(trimmedLine)) {
      const startLine = lineNumber;
      let formulaText = trimmedLine;
      if (trimmedLine.startsWith("$$") && trimmedLine !== "$$") {
        const trailing = formulaText.endsWith("$$") && formulaText.length > 4;
        if (!trailing) {
          while (index + 1 < lines.length && !formulaText.trimEnd().endsWith("$$")) {
            index += 1;
            formulaText += `\n${lines[index] ?? ""}`;
          }
        }
      } else if (trimmedLine === "$$") {
        while (index + 1 < lines.length && (lines[index + 1] ?? "").trim() !== "$$") {
          index += 1;
          formulaText += `\n${lines[index] ?? ""}`;
        }
        index += 1;
        formulaText += `\n${lines[index] ?? ""}`;
      }
      blocks.push({
        kind: "formula",
        lineStart: startLine,
        lineEnd: index + 1,
        text: formulaText,
        isDegraded: true,
        degradationReason: "公式以原始文本保留（不渲染、不执行宏）；排版属性缺失。",
        mustMarkUncertain: true,
      });
      index += 1;
      continue;
    }

    // 脚注定义 `[^id]: ...`
    const footnoteMatch = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(trimmedLine);
    if (footnoteMatch !== null) {
      blocks.push({
        kind: "footnote",
        lineStart: lineNumber,
        lineEnd: lineNumber,
        text: `[^${footnoteMatch[1] ?? ""}]: ${footnoteMatch[2] ?? ""}`,
        isDegraded: true,
        degradationReason: "脚注作为独立块保留；与正文锚点的自动关联未实现（不臆造关联）。",
        mustMarkUncertain: false,
      });
      index += 1;
      continue;
    }

    // 标题
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmedLine);
    if (headingMatch !== null) {
      const level = (headingMatch[1] ?? "#").length;
      blocks.push({
        kind: "heading",
        lineStart: lineNumber,
        lineEnd: lineNumber,
        text: headingMatch[2] ?? "",
        isDegraded: false,
        degradationReason: null,
        mustMarkUncertain: false,
      });
      knownLosses.push(`标题层级 ${String(level)} 以文本保留（不输出字号/颜色等样式）。`);
      index += 1;
      continue;
    }

    // 列表项
    if (/^([-*+]|\d+\.)\s+/.test(trimmedLine)) {
      blocks.push({
        kind: "list-item",
        lineStart: lineNumber,
        lineEnd: lineNumber,
        text: trimmedLine,
        isDegraded: false,
        degradationReason: null,
        mustMarkUncertain: false,
      });
      index += 1;
      continue;
    }

    // 修订/删除线（承担语义 ⇒ 标不确定）
    if (trimmedLine.includes("~~")) {
      blocks.push({
        kind: "revision",
        lineStart: lineNumber,
        lineEnd: lineNumber,
        text: trimmedLine,
        isDegraded: true,
        degradationReason: "删除线以原文保留；修订者/时间未提供（不臆造）。",
        mustMarkUncertain: true,
      });
      index += 1;
      continue;
    }

    // 普通段落（合并连续非空行）
    const startLine = lineNumber;
    const paragraphLines: string[] = [rawLine];
    while (
      index + 1 < lines.length &&
      (lines[index + 1] ?? "").trim() !== "" &&
      !/^(#{1,6}\s|```|\||\[\^|<!--|\$\$)/.test((lines[index + 1] ?? "").trim())
    ) {
      index += 1;
      paragraphLines.push(lines[index] ?? "");
    }
    blocks.push({
      kind: "paragraph",
      lineStart: startLine,
      lineEnd: index + 1,
      text: paragraphLines.join("\n").trim(),
      isDegraded: false,
      degradationReason: null,
      mustMarkUncertain: false,
    });
    index += 1;
  }

  if (isInFence) {
    knownLosses.push("文件结束仍处于未闭合的代码围栏：末段内容按代码块截止处截断，已如实标注。");
    blocks.push({
      kind: "code-block",
      lineStart: fenceStartLine,
      lineEnd: lines.length,
      text: fenceLines.join("\n"),
      isDegraded: true,
      degradationReason: "代码围栏未闭合：按文件末尾截断。",
      mustMarkUncertain: true,
    });
  }
  return { blocks, knownLosses };
}

/** html 适配器（去标签 + 结构检测；表格/删除线/插入/注释产出并标注）。 */
function extractHtmlBlocks(content: string): {
  blocks: MutableBlock[];
  knownLosses: string[];
} {
  const blocks: MutableBlock[] = [];
  const knownLosses: string[] = [];
  const lineNumberOf = (position: number): number => content.slice(0, position).split("\n").length;

  const pushMatch = (
    pattern: RegExp,
    kind: DocumentBlockKind,
    buildText: (match: RegExpExecArray) => string,
    degradationReason: string | null,
    mustMarkUncertain: boolean,
  ): void => {
    for (const match of content.matchAll(pattern)) {
      const position = match.index ?? 0;
      const matchedText = buildText(match);
      blocks.push({
        kind,
        lineStart: lineNumberOf(position),
        lineEnd: lineNumberOf(position + match[0].length),
        text: matchedText,
        isDegraded: degradationReason !== null,
        degradationReason,
        mustMarkUncertain,
      });
    }
  };

  // 表格：列关系保留为文本网格
  pushMatch(
    /<table[\s\S]*?<\/table>/gi,
    "table",
    (match) =>
      decodeHtmlEntities(
        (match[0].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) ?? [])
          .map((cell) => (cell.replace(/<[^>]+>/g, "") ?? "").trim())
          .join(" | "),
      ),
    "表格的列合并/表头 scope 不保证完整；单元格按行列顺序展开为文本。",
    false,
  );

  // 修订：<del>/<ins>/<s> 承担语义 ⇒ 标不确定
  for (const [pattern, label] of [
    [/<(del|s)>([\s\S]*?)<\/\1>/gi, "删除"],
    [/<ins>([\s\S]*?)<\/ins>/gi, "插入"],
  ] as const) {
    for (const match of content.matchAll(pattern)) {
      const position = match.index ?? 0;
      blocks.push({
        kind: "revision",
        lineStart: lineNumberOf(position),
        lineEnd: lineNumberOf(position + match[0].length),
        text: `[${label}] ${decodeHtmlEntities(match[0].replace(/<[^>]+>/g, ""))}`,
        isDegraded: true,
        degradationReason: "修订以文本保留；修订作者/时间未提供（不臆造）。",
        mustMarkUncertain: true,
      });
    }
  }

  // 隐藏内容：style 里 display:none / <template>
  pushMatch(
    /<(?:template|div)[^>]*style\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/(?:template|div)>/gi,
    "hidden-content",
    (match) => decodeHtmlEntities(match[0].replace(/<[^>]+>/g, "")).trim(),
    "隐藏内容（display:none/template）不计入正文，但已记录。",
    true,
  );

  // 注释
  pushMatch(
    /<!--[\s\S]*?-->/g,
    "hidden-content",
    (match) => match[0],
    "HTML 注释不计入正文，但已记录。",
    true,
  );

  // 标题
  for (const match of content.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const position = match.index ?? 0;
    blocks.push({
      kind: "heading",
      lineStart: lineNumberOf(position),
      lineEnd: lineNumberOf(position + match[0].length),
      text: decodeHtmlEntities((match[2] ?? "").replace(/<[^>]+>/g, "")).trim(),
      isDegraded: false,
      degradationReason: null,
      mustMarkUncertain: false,
    });
    knownLosses.push(`标题层级 ${match[1] ?? "?"} 以文本保留（不输出字号/颜色等样式）。`);
  }

  // 段落：无结构标签的文本（按行）
  const linesWithoutStructure = content
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter((entry) => {
      const trimmed = entry.line.trim();
      if (trimmed === "") return false;
      return !/^<[^>]+>$/.test(trimmed);
    });
  if (blocks.length === 0) {
    for (const entry of linesWithoutStructure) {
      blocks.push({
        kind: "paragraph",
        lineStart: entry.index + 1,
        lineEnd: entry.index + 1,
        text: decodeHtmlEntities(entry.line.replace(/<[^>]+>/g, "")).trim(),
        isDegraded: true,
        degradationReason: "该 HTML 无可识别的结构标签：按纯文本行给出，结构缺失如实标注。",
        mustMarkUncertain: true,
      });
    }
  }
  return { blocks, knownLosses };
}

/** 提取文档块（首批适配器）。 */
export function extractDocumentBlocks(input: {
  readonly fileName: string;
  readonly content: string;
}): DocumentExtractionResult {
  const sourceRevision = createHash("sha256").update(input.content).digest("hex");
  const format = detectFirstBatchDocumentFormat(input.fileName);

  if (format === null) {
    return {
      kind: "unsupported",
      format: null,
      blocks: [],
      knownLosses: [
        "首批适配器只覆盖 text/markdown/html；该格式需要额外解析器（且需解压膨胀防护），不作伪报。",
      ],
      isTruncated: false,
      sourceRevision,
      isFullFileWriteBackAllowed: false,
      executesMacrosOrScripts: false,
    };
  }

  const corruptionReason = detectCorruption(input.content);
  if (corruptionReason !== null) {
    return {
      kind: "corrupted",
      format,
      blocks: [],
      knownLosses: [corruptionReason],
      isTruncated: false,
      sourceRevision,
      isFullFileWriteBackAllowed: false,
      executesMacrosOrScripts: false,
    };
  }

  if (input.content.trim() === "") {
    return {
      kind: "extracted",
      format,
      blocks: [],
      knownLosses: ["文件为空：没有任何可读块（这不是“读取失败”）。"],
      isTruncated: false,
      sourceRevision,
      isFullFileWriteBackAllowed: false,
      executesMacrosOrScripts: false,
    };
  }

  const lines = input.content.split(/\r?\n/);
  const extraction =
    format === "markdown"
      ? extractMarkdownBlocks(lines)
      : format === "html"
        ? extractHtmlBlocks(input.content)
        : {
            blocks: lines.flatMap((line, index) =>
              line.trim() === ""
                ? []
                : [
                    {
                      kind: "paragraph" as const,
                      lineStart: index + 1,
                      lineEnd: index + 1,
                      text: line,
                      isDegraded: false,
                      degradationReason: null,
                      mustMarkUncertain: false,
                    },
                  ],
            ),
            knownLosses: [] as string[],
          };

  // 有界：块数与单块长度
  let isTruncated = false;
  const boundedBlocks: MutableBlock[] = [];
  for (const block of extraction.blocks) {
    if (boundedBlocks.length >= MAXIMUM_DOCUMENT_BLOCKS) {
      isTruncated = true;
      break;
    }
    if (block.text.length > MAXIMUM_DOCUMENT_BLOCK_CHARACTERS) {
      isTruncated = true;
      boundedBlocks.push({
        ...block,
        text: `${block.text.slice(0, MAXIMUM_DOCUMENT_BLOCK_CHARACTERS)}…`,
        isDegraded: true,
        degradationReason: "单块超过字符上限，已截断（需要完整内容请按块补读）。",
        mustMarkUncertain: true,
      });
      continue;
    }
    boundedBlocks.push(block);
  }

  // 阅读顺序：按行号排序，并据此生成 ordinal 与稳定锚点
  const orderedBlocks = [...boundedBlocks].sort((left, right) => {
    if (left.lineStart !== right.lineStart) return left.lineStart - right.lineStart;
    return left.lineEnd - right.lineEnd;
  });

  const blocks: DocumentBlockReceipt[] = orderedBlocks.map((block, index) => ({
    blockIdentifier: `${format}-block-${String(index + 1)}`,
    kind: block.kind,
    ordinal: index + 1,
    lineStart: block.lineStart,
    lineEnd: block.lineEnd,
    text: block.text,
    sourceAnchor: `${format}:line:${String(block.lineStart)}`,
    isDegraded: block.isDegraded,
    degradationReason: block.degradationReason,
    mustMarkUncertain: block.mustMarkUncertain,
  }));

  const knownLosses = [...new Set(extraction.knownLosses)];
  if (isTruncated) {
    knownLosses.push(
      `内容被截断（块数上限 ${String(MAXIMUM_DOCUMENT_BLOCKS)}、单块上限 ${String(MAXIMUM_DOCUMENT_BLOCK_CHARACTERS)} 字符）。`,
    );
  }

  return {
    kind: "extracted",
    format,
    blocks,
    knownLosses,
    isTruncated,
    sourceRevision,
    isFullFileWriteBackAllowed: false,
    executesMacrosOrScripts: false,
  };
}
