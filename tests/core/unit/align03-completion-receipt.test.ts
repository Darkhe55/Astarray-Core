/**
 * ALIGN-03：**完成收据**判定与构造（此前 `tests/` 下**零引用**，属生产路径却无自动化覆盖）。
 *
 * 判定规则刻意保守——"缺失即不足"，本文件用反例把它钉死：
 * 没有收据 / 未校验完成事件 / 缺任务标识 / 非法工具计数 / 空产物路径 ⇒ 一律不足。
 */
import { describe, expect, it } from "vitest";

import {
  buildCompletionReceipt,
  evaluateCompletionReceipt,
} from "../../../packages/core/src/orchestration/completion-receipt.js";
import type { CompletionReceipt } from "../../../packages/core/src/orchestration/completion-receipt.js";

function buildValidReceipt(overrides: Partial<CompletionReceipt> = {}): CompletionReceipt {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    hasVerifiedCompletionControlEvent: true,
    toolCallCount: 3,
    artifactPaths: ["src/a.ts"],
    recordedAtIso: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("完成收据判定", () => {
  it("① 没有收据 ⇒ 不足（不得补默认收据）", () => {
    const result = evaluateCompletionReceipt({
      receipt: null,
      requiresCompletionControlEvent: false,
    });
    expect(result.isSufficient).toBe(false);
    expect(result.reasons.join("|")).toContain("缺少完成收据");
  });

  it("② 要求完成控制事件但未声明已校验 ⇒ 不足", () => {
    const result = evaluateCompletionReceipt({
      receipt: buildValidReceipt({ hasVerifiedCompletionControlEvent: false }),
      requiresCompletionControlEvent: true,
    });
    expect(result.isSufficient).toBe(false);
    expect(result.reasons.join("|")).toContain("未声明已校验");
  });

  it("③ 缺任务标识 ⇒ 不足；构造时直接拒绝", () => {
    const evaluation = evaluateCompletionReceipt({
      receipt: buildValidReceipt({ taskIdentifier: "  " }),
      requiresCompletionControlEvent: false,
    });
    expect(evaluation.isSufficient).toBe(false);
    expect(() => buildCompletionReceipt(buildValidReceipt({ taskIdentifier: "" }))).toThrow(
      /任务标识/u,
    );
  });

  it("④ 非法工具计数（负数 / 非整数）⇒ 不足", () => {
    for (const toolCallCount of [-1, 1.5]) {
      const result = evaluateCompletionReceipt({
        receipt: buildValidReceipt({ toolCallCount }),
        requiresCompletionControlEvent: false,
      });
      expect(result.isSufficient).toBe(false);
      expect(result.reasons.join("|")).toContain("工具调用计数非法");
    }
  });

  it("⑤ 空产物路径 ⇒ 不足（宁可 block 也不谎报完成）", () => {
    const result = evaluateCompletionReceipt({
      receipt: buildValidReceipt({ artifactPaths: ["src/a.ts", "  "] }),
      requiresCompletionControlEvent: false,
    });
    expect(result.isSufficient).toBe(false);
    expect(result.reasons.join("|")).toContain("空的产物路径");
  });

  it("⑥ 合法收据 ⇒ 足够；构造后产物数组是副本（外部修改不污染收据）", () => {
    const source = buildValidReceipt();
    const receipt = buildCompletionReceipt(source);
    expect(
      evaluateCompletionReceipt({ receipt, requiresCompletionControlEvent: true }).isSufficient,
    ).toBe(true);

    const mutablePaths = [...source.artifactPaths] as string[];
    mutablePaths.push("src/b.ts");
    expect(receipt.artifactPaths).toEqual(["src/a.ts"]);
  });
});
