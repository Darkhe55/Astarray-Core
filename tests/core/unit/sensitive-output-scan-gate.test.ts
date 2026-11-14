/**
 * 输出敏感扫描的跨块门禁（2026-11-14，新模块；EXEC-01-03 剩余缺口）。
 *
 * 核心断言：**秘密被切成两块时，第一块不得先发出去**。
 * 这是卡内 §03「不能先发送秘密片段再补扫描」的直接反例。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOUNDARY_CARRY_CHARACTERS,
  scanOutputChunkAcrossBoundaries,
} from "../../../packages/core/src/execution/sensitive-output-scan-gate.js";

/** 一个会被 `redactSensitiveText` 命中的真实形状（假值，仅测试用）。 */
const SECRET = `sk-${"g".repeat(24)}`;

describe("跨块敏感扫描", () => {
  it("① 秘密被切成两块 ⇒ 第一块不外发，拼接后才脱敏", () => {
    const firstHalf = SECRET.slice(0, 6);
    const secondHalf = SECRET.slice(6);

    const first = scanOutputChunkAcrossBoundaries({
      chunkText: firstHalf,
      previousCarryText: "",
      carryCharacters: 32,
    });
    /** 只有 6 个字符、不足暂扣窗口 ⇒ 一个字都不发。 */
    expect(first.textToEmit).toBe("");
    expect(first.isBoundaryWithheld).toBe(true);

    const second = scanOutputChunkAcrossBoundaries({
      chunkText: secondHalf,
      previousCarryText: first.carryText,
      carryCharacters: 32,
    });
    /** 拼接后命中脱敏；外发文本里不得出现秘密的任何片段。 */
    expect(second.textToEmit).not.toContain(SECRET.slice(0, 6));
    expect(second.isRedacted).toBe(true);
  });

  it("② 暂扣窗口长度由调用方决定，且不足窗口时全部暂扣", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: "abc",
      previousCarryText: "",
      carryCharacters: 128,
    });
    expect(result.textToEmit).toBe("");
    expect(result.carryText).toBe("abc");
    expect(result.isBoundaryWithheld).toBe(true);
  });

  it("③ 窗口为 0 ⇒ 立即全量输出（保留旧的按块行为）", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: `正常输出 ${SECRET}`,
      previousCarryText: "",
      carryCharacters: 0,
    });
    expect(result.isBoundaryWithheld).toBe(false);
    expect(result.isRedacted).toBe(true);
    expect(result.textToEmit).toContain("正常输出");
    expect(result.textToEmit).not.toContain(SECRET);
  });

  it("④ 保留的尾巴本身已脱敏（不在内存里多留一份明文）", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: `前缀 ${SECRET}`,
      previousCarryText: "",
      carryCharacters: 64,
    });
    expect(result.carryText).not.toContain(SECRET);
  });

  it("⑤ 无敏感内容时文本原样保留（除暂扣尾），不误报脱敏", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: "构建成功，用时 1.2s".padEnd(200, "。"),
      previousCarryText: "",
      carryCharacters: 32,
    });
    expect(result.isRedacted).toBe(false);
    expect(result.textToEmit.startsWith("构建成功")).toBe(true);
    expect(result.textToEmit.length).toBe(200 - 32);
  });

  it("⑥ 扫描范围如实回报；默认值不得夸大为 whole-stream", () => {
    const byDefault = scanOutputChunkAcrossBoundaries({
      chunkText: "x",
      previousCarryText: "",
    });
    expect(byDefault.scanScope).toBe("per-chunk");
    const declared = scanOutputChunkAcrossBoundaries({
      chunkText: "x",
      previousCarryText: "",
      scanScope: "whole-stream",
    });
    expect(declared.scanScope).toBe("whole-stream");
    expect(DEFAULT_BOUNDARY_CARRY_CHARACTERS).toBeGreaterThan(0);
  });
});
