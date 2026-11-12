/**
 * 日志行安全化（此前 `tests/` 零引用）：**只防换行注入，不是脱敏**。
 *
 * 反例：伪造日志行 / 行分隔符 / 超长截断 / 边界限额；
 * 并明确断言"秘密仍会保留"——避免被当成脱敏层误用。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAXIMUM_LOG_LINE_CHARACTERS,
  formatDiagnosticLogLine,
  sanitizeLogLine,
} from "../../../packages/core/src/infra/log-line-safety.js";

describe("日志行安全化", () => {
  it("① 换行与回车被转义为可见字符，结果不含真实换行", () => {
    const result = sanitizeLogLine("第一行\n第二行\r第三行\r\n第四行");
    expect(result.text).toBe("第一行\\n第二行\\r第三行\\n第四行");
    expect(result.text.includes("\n")).toBe(false);
    expect(result.text.includes("\r")).toBe(false);
  });

  it("② U+2028 / U+2029 也被转义", () => {
    const result = sanitizeLogLine("甲\u2028乙\u2029丙");
    expect(result.text).toBe("甲\\u2028乙\\u2029丙");
    expect(result.text.includes("\u2028")).toBe(false);
    expect(result.text.includes("\u2029")).toBe(false);
  });

  it("③ 换行计数精确：`\\r\\n` 算一次，空串为 0", () => {
    expect(sanitizeLogLine("").escapedLineBreakCount).toBe(0);
    expect(sanitizeLogLine("a\r\nb").escapedLineBreakCount).toBe(1);
    expect(sanitizeLogLine("a\r\nb\nc\rd").escapedLineBreakCount).toBe(3);
    expect(sanitizeLogLine("a\u2028b\u2029c").escapedLineBreakCount).toBe(2);
  });

  it("④ 不改调用方原文（返回新字符串，原文本仍是多行）", () => {
    const original = "一行\n二行";
    const result = sanitizeLogLine(original);
    expect(original).toBe("一行\n二行");
    expect(result.text).not.toBe(original);
    expect(result.originalLength).toBe(original.length);
  });

  it("⑤ 有界截断：超限标注截断字符数，未超限不标注", () => {
    const truncated = sanitizeLogLine("x".repeat(50), 10);
    expect(truncated.isTruncated).toBe(true);
    expect(truncated.text.startsWith("x".repeat(10))).toBe(true);
    expect(truncated.text).toContain("[truncated 40 chars]");

    const notTruncated = sanitizeLogLine("短文本");
    expect(notTruncated.isTruncated).toBe(false);
    expect(notTruncated.text).toBe("短文本");
  });

  it("⑥ 限额边界：0 或负数至少保留 1 个字符（不会产出空行）", () => {
    for (const limit of [0, -5]) {
      const result = sanitizeLogLine("abcdef", limit);
      expect(result.isTruncated).toBe(true);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text.startsWith("a")).toBe(true);
    }
    expect(DEFAULT_MAXIMUM_LOG_LINE_CHARACTERS).toBe(2_000);
  });

  it("⑦ formatDiagnosticLogLine：前缀 + 安全正文，整行不含换行", () => {
    const line = formatDiagnosticLogLine({
      prefix: "[INFO] ",
      message: "工具输出\n伪造的下一行",
    });
    expect(line.line.startsWith("[INFO] ")).toBe(true);
    expect(line.line.includes("\n")).toBe(false);
    expect(line.escapedLineBreakCount).toBe(1);
    expect(line.isTruncated).toBe(false);
  });

  it("⑧ 仿冒日志行注入：伪造的级别前缀不会变成独立一行", () => {
    const attack = "正常消息\n[ERROR] 伪造错误：系统已被攻破";
    const line = formatDiagnosticLogLine({ prefix: "[INFO] ", message: attack });
    expect(line.line.split("\n")).toHaveLength(1);
    expect(line.line).toContain("[ERROR] 伪造错误");
    expect(line.escapedLineBreakCount).toBe(1);
  });

  it("⑨ **不是脱敏**：硬编码的假密钥仍原样保留（明确边界，防误用）", () => {
    const fakeKey = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
    const result = sanitizeLogLine(`请求头里带着 ${fakeKey}`);
    expect(result.text).toContain(fakeKey);
  });
});
