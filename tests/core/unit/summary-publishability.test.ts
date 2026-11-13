/**
 * 摘要写入前检查（此前 `tests/` 零引用）：`tools/content-publishability` 的**摘要侧薄封装**。
 *
 * 这里最重要的一条是 ④：两侧结果必须**完全一致**。
 * 一旦有人在这个封装里另写一套规则，摘要与记忆/汇报的判定就会开始漂移——
 * 那类漂移不会报错，只会让某些内容在一条路径上被放行。
 */
import { describe, expect, it } from "vitest";

import { evaluateContentPublishability } from "../../../packages/core/src/tools/content-publishability.js";
import { evaluateSummaryPublishability } from "../../../packages/core/src/summarization/summary-publishability.js";

const FAKE_TOKEN = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

describe("摘要可发布性", () => {
  it("① 干净摘要 ⇒ 可发布（原因仍是「未命中已知规则」）", () => {
    const evaluation = evaluateSummaryPublishability("本次会话完成了三处修复，全部测试通过。");
    expect(evaluation.isPublishable).toBe(true);
    expect(evaluation.outcome).toBe("clean");
    expect(evaluation.reason).toContain("未命中已知规则");
  });

  it("② 摘要里带凭据 ⇒ 不可落盘，并给出规则标识", () => {
    const evaluation = evaluateSummaryPublishability(`摘要：配置里写着 ${FAKE_TOKEN}`);
    expect(evaluation.isPublishable).toBe(false);
    expect(evaluation.matchedRuleIdentifiers.length).toBeGreaterThan(0);
  });

  it("③ 扫描没跑完（超长摘要）⇒ 同样不可落盘", () => {
    const evaluation = evaluateSummaryPublishability("普通内容".repeat(400_000));
    expect(evaluation.isPublishable).toBe(false);
    expect(evaluation.outcome).toBe("incomplete");
  });

  it("④ **与通用实现完全等价**（薄封装不得有第二套规则）", () => {
    const samples = [
      "普通摘要文本",
      `含凭据 ${FAKE_TOKEN}`,
      "",
    ];
    for (const sample of samples) {
      expect(evaluateSummaryPublishability(sample)).toEqual(evaluateContentPublishability(sample));
    }
  });

  it("⑤ 结果不含摘要正文（判定结果不是新的泄漏面）", () => {
    const summary = `机密摘要：${FAKE_TOKEN}`;
    const serialized = JSON.stringify(evaluateSummaryPublishability(summary));
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("机密摘要");
  });
});
