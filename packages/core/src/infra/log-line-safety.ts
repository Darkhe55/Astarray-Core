/**
 * SEC-02 通道 14 / R18（2026-10-29）：**日志行安全化**（换行注入加固）。
 *
 * 风险：日志里拼入的变量（子进程 stderr、异常消息、工具输出）可能含换行，
 * 一行日志会被拆成多行，从而**伪造**额外日志行/结构化字段（log injection）。
 *
 * 做法（只作用于**日志行**，不改业务文本）：
 * - 把 `\r\n` / `\r` / `\n` / U+2028 / U+2029 替换为可见转义（`\\r` / `\\n` / `\\u2028` / `\\u2029`）；
 * - 有界截断（缺省 2000 字符），并标注截断；
 * - 返回**转义计数**，让调用方知道"这行本来是多行"。
 *
 * 边界：
 * - **不是脱敏**：秘密仍可能在这行里（脱敏由 `Redactor`/扫描层负责）；
 * - **不改调用方原字符串**：返回新字符串；
 * - 仅用于日志；不要用它改写 IPC/JSON/协议载荷。
 */
export interface SanitizedLogLine {
  /** 单行结果（已转义换行、已截断）。 */
  readonly text: string;
  /** 被替换的换行/行分隔符数量（原始文本中）。 */
  readonly escapedLineBreakCount: number;
  readonly isTruncated: boolean;
  readonly originalLength: number;
}

export const DEFAULT_MAXIMUM_LOG_LINE_CHARACTERS = 2_000;

export function sanitizeLogLine(
  input: string,
  maximumCharacters: number = DEFAULT_MAXIMUM_LOG_LINE_CHARACTERS,
): SanitizedLogLine {
  const escaped = input
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const escapedLineBreakCount =
    input.length === 0
      ? 0
      : (input.match(/\r\n|\r|\n|\u2028|\u2029/g) ?? []).length;
  const limit = Math.max(1, Math.trunc(maximumCharacters));
  const isTruncated = escaped.length > limit;
  const text = isTruncated
    ? `${escaped.slice(0, limit)}…[truncated ${String(escaped.length - limit)} chars]`
    : escaped;
  return {
    text,
    escapedLineBreakCount,
    isTruncated,
    originalLength: input.length,
  };
}

/**
 * 生成一条"前缀 + 安全化正文"的日志行（**不含换行**）。
 *
 * 调用方自行追加行尾换行（`\n`）；本函数保证正文内部不再引入换行。
 */
export function formatDiagnosticLogLine(input: {
  readonly prefix: string;
  readonly message: string;
  readonly maximumCharacters?: number;
}): { readonly line: string; readonly escapedLineBreakCount: number; readonly isTruncated: boolean } {
  const sanitized = sanitizeLogLine(
    input.message,
    input.maximumCharacters ?? DEFAULT_MAXIMUM_LOG_LINE_CHARACTERS,
  );
  return {
    line: `${input.prefix}${sanitized.text}`,
    escapedLineBreakCount: sanitized.escapedLineBreakCount,
    isTruncated: sanitized.isTruncated,
  };
}
