/**
 * 输出敏感扫描的跨块门禁（2026-11-14，第二轮：仅在可疑时暂扣）。
 *
 * 第一轮无脑暂扣末尾窗口，会把普通短输出整体延迟（破坏"普通输出原样返回"的既有约束）。
 * 本轮改为**先判可疑再暂扣**：只有尾部可能是某个秘密的开头时才扣住。
 *
 * 核心断言仍然是：**秘密被切成两块时，第一块不得先发出去**。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOUNDARY_CARRY_CHARACTERS,
  findSuspiciousTailLength,
  scanOutputChunkAcrossBoundaries,
} from "../../../packages/core/src/execution/sensitive-output-scan-gate.js";

/** 一个会被 `redactSensitiveText` 命中的真实形状（假值，仅测试用）。 */
const SECRET = `sk-${"g".repeat(24)}`;

describe("可疑尾部判定", () => {
  it("① 尾部是秘密前缀 ⇒ 从该前缀起暂扣", () => {
    expect(findSuspiciousTailLength(`token=${SECRET.slice(0, 6)}`, 128)).toBe(6);
    expect(findSuspiciousTailLength("push ghp_abc", 128)).toBe(7);
  });

  it("② 普通文本（含中文、标点、空格结尾）⇒ 不暂扣", () => {
    expect(findSuspiciousTailLength("编译完成，耗时 1.2s\n", 128)).toBe(0);
    expect(findSuspiciousTailLength("done.", 128)).toBe(0);
    expect(findSuspiciousTailLength("", 128)).toBe(0);
    expect(findSuspiciousTailLength("abcdefg", 128)).toBe(0);
  });

  it("③ 长随机串（≥8 位连续字母数字收尾）也要暂扣（可能是 32 位凭据的前半段）", () => {
    expect(findSuspiciousTailLength("hash 0123456789abcdef", 128)).toBe(16);
  });
});

describe("跨块扫描（可疑才暂扣）", () => {
  it("④ 秘密被切成两块 ⇒ 第一块不外发，拼接后才脱敏", () => {
    const first = scanOutputChunkAcrossBoundaries({
      chunkText: `token=${SECRET.slice(0, 6)}`,
      previousCarryText: "",
      carryCharacters: 128,
    });
    expect(first.textToEmit).toBe("token=");
    expect(first.isBoundaryWithheld).toBe(true);

    const second = scanOutputChunkAcrossBoundaries({
      chunkText: SECRET.slice(6),
      previousCarryText: first.carryText,
      carryCharacters: 128,
    });
    expect(second.textToEmit).not.toContain(SECRET.slice(0, 6));
    expect(second.isRedacted).toBe(true);
  });

  it("⑤ 普通输出立即全量返回（不再整体延迟）", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: "编译完成，耗时 1.2s\n",
      previousCarryText: "",
      carryCharacters: 128,
    });
    expect(result.textToEmit).toBe("编译完成，耗时 1.2s\n");
    expect(result.isBoundaryWithheld).toBe(false);
    expect(result.isRedacted).toBe(false);
  });

  it("⑥ 块内完整秘密 ⇒ 直接脱敏并全量输出（不暂扣）", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: `token=${SECRET}\n`,
      previousCarryText: "",
      carryCharacters: 128,
    });
    expect(result.textToEmit).not.toContain(SECRET);
    expect(result.textToEmit).toContain("[REDACTED]");
    expect(result.isBoundaryWithheld).toBe(false);
  });

  it("⑦ 窗口为 0 ⇒ 关闭暂扣，行为等同旧的按块扫描", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: `token=${SECRET.slice(0, 6)}`,
      previousCarryText: "",
      carryCharacters: 0,
    });
    expect(result.isBoundaryWithheld).toBe(false);
    expect(result.textToEmit).toBe(`token=${SECRET.slice(0, 6)}`);
  });

  it("⑧ 保留的尾巴本身已脱敏；扫描范围如实回报", () => {
    const result = scanOutputChunkAcrossBoundaries({
      chunkText: `前缀 ${SECRET}`,
      previousCarryText: "",
      carryCharacters: 64,
      scanScope: "whole-stream",
    });
    expect(result.carryText).not.toContain(SECRET);
    expect(result.scanScope).toBe("whole-stream");
    expect(DEFAULT_BOUNDARY_CARRY_CHARACTERS).toBeGreaterThan(0);
  });
});
