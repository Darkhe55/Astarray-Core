/**
 * Headless CLI JSON 输出与退出码约定（T11）。
 * --json 模式：stdout 只输出机器可解析结果；日志与警告写 stderr。
 */

import { sanitizeLogLine } from "../../../core/src/infra/log-line-safety.js";
import { redactSensitiveText } from "../../../core/src/orchestration/diagnostic-event-store.js";
import { sanitizeRunHistoryDisplayText } from "../../../core/src/orchestration/run-history-view.js";

export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE_ERROR: 2,
} as const;

export function printJson(output: unknown): void {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

/**
 * 诊断输出**唯一漏斗**（SEC-02 通道 14，2026-11-09）。
 *
 * 为什么在这里收口：CLI 的报错文本会拼进异常消息、子进程 stderr、工具输出，
 * 其中可能带**换行**（可伪造额外日志行）与**凭据**。此前这里原样写出 ⇒
 * 两条风险都直接落到终端/日志文件。
 *
 * 处理顺序：先脱敏（凭据），再安全化（换行注入 + 有界截断）。
 */
export function logToStderr(message: string): void {
  writeDiagnosticText(`astarray: ${message}`);
}

/**
 * 诊断文本的**唯一写出点**（不加 `astarray:` 前缀，保持既有输出形态）。
 *
 * 供原先直接 `process.stderr.write` 的调用点使用：行为等价，但统一经过
 * 脱敏 + 换行转义 + 有界截断。
 */
export function writeDiagnosticText(text: string): void {
  /**
   * 顺序：**去 ANSI → 脱敏 → 换行转义 + 截断**。
   *
   * 为什么要去 ANSI（SEC-02 通道 14 剩余项）：子进程 stderr 与工具输出可能带
   * 颜色/光标/清屏序列，直接写终端会**覆盖已显示的报错**（攻击者可让"失败"
   * 看起来像"成功"），落到日志文件则是不可读噪声。
   */
  const withoutAnsi = sanitizeRunHistoryDisplayText(text);
  const redactedMessage = redactSensitiveText(withoutAnsi);
  const sanitized = sanitizeLogLine(redactedMessage);
  process.stderr.write(`${sanitized.text}\n`);
}

export function failWith(
  error: Error,
  exitCode: number = EXIT_CODES.FAILURE,
): never {
  logToStderr(error.message);
  process.exit(exitCode);
}
