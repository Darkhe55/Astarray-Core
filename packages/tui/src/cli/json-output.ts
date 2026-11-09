/**
 * Headless CLI JSON 输出与退出码约定（T11）。
 * --json 模式：stdout 只输出机器可解析结果；日志与警告写 stderr。
 */

import { sanitizeLogLine } from "../../../core/src/infra/log-line-safety.js";
import { redactSensitiveText } from "../../../core/src/orchestration/diagnostic-event-store.js";

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
  const redactedMessage = redactSensitiveText(message);
  const sanitized = sanitizeLogLine(redactedMessage);
  process.stderr.write(`astarray: ${sanitized.text}\n`);
}

export function failWith(
  error: Error,
  exitCode: number = EXIT_CODES.FAILURE,
): never {
  logToStderr(error.message);
  process.exit(exitCode);
}
