/**
 * 严格整数选项解析的反例（2026-10-19 R84）。
 */
import { describe, expect, it } from "vitest";

import { parseStrictPositiveIntegerOption } from "../../../packages/tui/src/cli/strict-integer-option.js";

describe("严格整数选项", () => {
  it("① 未提供 ⇒ undefined（调用方据此跳过）", () => {
    expect(parseStrictPositiveIntegerOption(undefined, "--page")).toBeUndefined();
  });

  it("② 纯数字（允许前后空白）⇒ 解析成功", () => {
    expect(parseStrictPositiveIntegerOption("12", "--page")).toEqual({ kind: "ok", value: 12 });
    expect(parseStrictPositiveIntegerOption(" 12 ", "--page")).toEqual({ kind: "ok", value: 12 });
  });

  it("③ parseInt 会截断的垃圾输入必须拒绝（5abc / 1e5 / 10.5 / -7 / 空串）", () => {
    for (const rawValue of ["5abc", "1e5", "10.5", "-7", "", "  "]) {
      const result = parseStrictPositiveIntegerOption(rawValue, "--page");
      expect(result?.kind, rawValue).toBe("error");
    }
  });

  it("④ 低于下限 / 高于上限 ⇒ 拒绝（0 不算正整数）", () => {
    expect(parseStrictPositiveIntegerOption("0", "--page")?.kind).toBe("error");
    expect(
      parseStrictPositiveIntegerOption("501", "--page-size", { minimum: 1, maximum: 500 })?.kind,
    ).toBe("error");
    expect(
      parseStrictPositiveIntegerOption("500", "--page-size", { minimum: 1, maximum: 500 })?.kind,
    ).toBe("ok");
  });

  it("⑤ 错误消息里**带参数名与原始输入**（便于定位，不静默）", () => {
    const result = parseStrictPositiveIntegerOption("5abc", "--budget-bytes");
    if (result?.kind !== "error") throw new Error("应拒绝");
    expect(result.message).toContain("--budget-bytes");
    expect(result.message).toContain("5abc");
  });
});
