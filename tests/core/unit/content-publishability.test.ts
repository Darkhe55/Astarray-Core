/**
 * 可发布性判定（此前 `tests/` 零引用）：派生内容落盘前的 fail-closed 闸门。
 *
 * 三条边界：**不做脱敏**（命中即不可发布，不改原文继续写）、
 * 结果**不含正文**、`clean` 只表示"扫完且未命中已知规则"，不宣称安全。
 */
import { describe, expect, it } from "vitest";

import { SENSITIVE_SCAN_RULE_SET_VERSION } from "../../../packages/core/src/tools/sensitive-content-scan-contract.js";
import { evaluateContentPublishability } from "../../../packages/core/src/tools/content-publishability.js";

const FAKE_TOKEN = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

describe("内容可发布性", () => {
  it("① 干净内容 ⇒ 可发布，原因说明是「未命中已知规则」而非「安全」", () => {
    const evaluation = evaluateContentPublishability("这是一段普通的摘要片段。");
    expect(evaluation.isPublishable).toBe(true);
    expect(evaluation.outcome).toBe("clean");
    expect(evaluation.matchedRuleIdentifiers).toEqual([]);
    expect(evaluation.limitReason).toBeNull();
    expect(evaluation.reason).toContain("未命中已知规则");
    expect(evaluation.ruleSetVersion).toBe(SENSITIVE_SCAN_RULE_SET_VERSION);
  });

  it("② 命中规则 ⇒ 不可发布，原因里列出规则标识", () => {
    const evaluation = evaluateContentPublishability(`记忆片段：${FAKE_TOKEN}`);
    expect(evaluation.isPublishable).toBe(false);
    expect(evaluation.outcome).toBe("sensitive");
    expect(evaluation.matchedRuleIdentifiers.length).toBeGreaterThan(0);
    expect(evaluation.reason).toContain(evaluation.matchedRuleIdentifiers[0]!);
  });

  it("③ **没扫完也不可发布**：超字节上限 ⇒ incomplete + 限制原因", () => {
    const evaluation = evaluateContentPublishability("普通内容".repeat(400_000));
    expect(evaluation.isPublishable).toBe(false);
    expect(evaluation.outcome).toBe("incomplete");
    expect(evaluation.limitReason).not.toBeNull();
    expect(evaluation.reason).toContain("incomplete");
  });

  it("④ 不做脱敏：结果不含正文与凭据值（命中即拒绝，而不是替换后放行）", () => {
    const content = `机密：${FAKE_TOKEN} 其余内容`;
    const evaluation = evaluateContentPublishability(content);
    const serialized = JSON.stringify(evaluation);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("机密：");
    expect(Object.keys(evaluation)).not.toContain("content");
    expect(Object.keys(evaluation)).not.toContain("sanitizedContent");
    /** 命中时依然是"不可发布"，而不是"已脱敏可发布"。 */
    expect(evaluation.isPublishable).toBe(false);
  });

  it("⑤ 纯函数：同一输入两次结果一致（无隐藏状态）", () => {
    const content = "同一段派生内容";
    expect(evaluateContentPublishability(content)).toEqual(evaluateContentPublishability(content));
  });
});
