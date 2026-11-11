import { createHash } from "node:crypto";

/**
 * CLUSTER-01 §2/§4：**有界分页读取**端口。
 *
 * 现状缺口：`DiagnosticEventStore.readAll` / `readWithIntegrity` 一次读整个文件，
 * 无法用于"每批 200 行、单行最多 64 KiB、每次扫描最多 2,000 条"的后台扫描。
 *
 * 本模块只做**纯解析**：给定 JSONL 文本与游标，返回一页记录 + 下一条游标。
 * 不读文件、不做作用域过滤、不脱敏——那些由上层负责，避免把策略混进分页逻辑。
 *
 * 关键约束（卡内要求）：
 * - 游标按**字节偏移 + 行号**定位，指向"下一行起点"；
 * - 每条记录带该行内容的 SHA256，供 §3 第 8 条"引用必须验证内容哈希"使用；
 * - 超长行**跳过并计数**，不得让单行撑爆内存；
 * - 末尾无换行的最后一行仍然可读。
 */

export interface DiagnosticPageCursor {
  /** 下一行起点在文本中的字节偏移。 */
  readonly byteOffset: number;
  /** 已消费的行数（从 0 开始）。 */
  readonly lineNumber: number;
}

export interface DiagnosticPageRecord {
  readonly lineNumber: number;
  readonly byteOffset: number;
  readonly contentSha256: string;
  readonly text: string;
}

export interface DiagnosticPage {
  readonly records: readonly DiagnosticPageRecord[];
  readonly nextCursor: DiagnosticPageCursor;
  /** 是否已读到文本末尾。 */
  readonly isComplete: boolean;
  /** 因超过单行上限被跳过的行数。 */
  readonly skippedOversizeLineCount: number;
}

export interface ReadDiagnosticPageOptions {
  readonly content: string;
  readonly cursor?: DiagnosticPageCursor;
  /** 每批最多返回多少行（卡内默认 200）。 */
  readonly limit?: number;
  /** 单行最多多少字节（卡内默认 64 KiB）。 */
  readonly maximumLineBytesPerLine?: number;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

/**
 * 读取一页。返回的 `nextCursor` 可直接作为下一次调用的 `cursor`；
 * `isComplete === true` 时表示已到末尾，再调用只会返回空页。
 */
export function readDiagnosticPage(options: ReadDiagnosticPageOptions): DiagnosticPage {
  const content = options.content;
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const maximumLineBytes = Math.max(1, options.maximumLineBytesPerLine ?? DEFAULT_MAX_LINE_BYTES);
  const cursor = options.cursor ?? { byteOffset: 0, lineNumber: 0 };
  const byteBuffer = Buffer.from(content, "utf8");

  const records: DiagnosticPageRecord[] = [];
  let skippedOversizeLineCount = 0;
  let offset = Math.min(cursor.byteOffset, byteBuffer.length);
  let lineNumber = cursor.lineNumber;
  let isComplete = offset >= byteBuffer.length;

  while (records.length < limit && !isComplete) {
    const lineEndIndex = byteBuffer.indexOf(0x0a, offset);
    const isLastLine = lineEndIndex === -1;
    const lineEnd = isLastLine ? byteBuffer.length : lineEndIndex;
    /** 去掉行尾的 \r（CRLF 文件）。 */
    const contentEnd = lineEnd > offset && byteBuffer[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
    const lineByteLength = contentEnd - offset;
    const startOffset = offset;
    offset = isLastLine ? byteBuffer.length : lineEnd + 1;

    if (lineByteLength > maximumLineBytes) {
      /** 超长行：跳过并计数，游标照常前进（否则会死循环）。 */
      skippedOversizeLineCount += 1;
      lineNumber += 1;
      isComplete = isLastLine;
      continue;
    }

    const lineBuffer = byteBuffer.subarray(startOffset, contentEnd);
    const text = lineBuffer.toString("utf8");
    /** 空行不是记录，但行号与偏移仍要前进，否则游标会错位。 */
    if (text.trim() !== "") {
      records.push({
        lineNumber,
        byteOffset: startOffset,
        contentSha256: createHash("sha256").update(lineBuffer).digest("hex"),
        text,
      });
    }
    lineNumber += 1;
    isComplete = isLastLine;
  }

  return {
    records,
    nextCursor: { byteOffset: offset, lineNumber },
    isComplete,
    skippedOversizeLineCount,
  };
}

/** 逐页读完整个文本（测试与后台扫描的便捷封装；仍受每页上限约束）。 */
export function readAllDiagnosticPages(
  options: Omit<ReadDiagnosticPageOptions, "cursor">,
): readonly DiagnosticPage[] {
  const pages: DiagnosticPage[] = [];
  let cursor: DiagnosticPageCursor | undefined;
  for (;;) {
    const page = readDiagnosticPage({ ...options, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page);
    if (page.isComplete) return pages;
    cursor = page.nextCursor;
  }
}
