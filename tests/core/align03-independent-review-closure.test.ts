/**
 * ALIGN-03-01（2026-11-10）：**独立验收闭环**的状态机与守卫。
 *
 * 用户裁决（本轮）：产物"存在且非空"不得直接算 `merge-ready`；
 * 产物存在性只是送审前置条件，独立验收必须由**真实审查任务**产出裁决；
 * 禁止仅登记审查者身份即视作完成；禁止审查失败后仍宣称任务最终完成。
 */
import { describe, expect, it } from "vitest";

import {
  deriveTaskAcceptanceState,
  describeAcceptanceState,
  evaluateIndependentReview,
  isFinalCompletionAllowed,
} from "../../packages/core/src/orchestration/independent-review-closure.js";

import type { IndependentReviewOutcome } from "../../packages/core/src/orchestration/independent-review-closure.js";

function buildReviewOutcome(
  overrides: Partial<IndependentReviewOutcome> = {},
): IndependentReviewOutcome {
  return {
    reviewTaskIdentifier: "review-task-1",
    reviewTaskStatus: "done",
    verdict: "merge-ready",
    evidenceReferences: ["artifact:docs/out.md", "test:vitest"],
    ...overrides,
  };
}

describe("ALIGN-03-01 独立验收状态机", () => {
  it("产物前置不满足 ⇒ **rework**（连送审资格都没有）", () => {
    const state = deriveTaskAcceptanceState({
      isArtifactPreconditionSatisfied: false,
      reviewOutcome: buildReviewOutcome(),
    });
    expect(state).toBe("rework");
  });

  it("**没有审查结果** ⇒ execution-done（绝不 accepted）", () => {
    const state = deriveTaskAcceptanceState({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: null,
    });
    expect(state).toBe("execution-done");
    expect(isFinalCompletionAllowed(state)).toBe(false);
  });

  it("**仅登记审查者身份、没有审查任务** ⇒ execution-done + 明确原因码", () => {
    const outcome = buildReviewOutcome({
      reviewTaskIdentifier: null,
      reviewTaskStatus: null,
      verdict: null,
      evidenceReferences: [],
    });
    const evaluation = evaluateIndependentReview({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: outcome,
    });
    expect(evaluation.acceptanceState).toBe("execution-done");
    expect(evaluation.blockReasonCodes).toContain("reviewer-registration-is-not-review");
    expect(isFinalCompletionAllowed(evaluation.acceptanceState)).toBe(false);
  });

  it("审查任务**未完成** ⇒ pending-acceptance（不是通过）", () => {
    const evaluation = evaluateIndependentReview({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: buildReviewOutcome({ reviewTaskStatus: "running", verdict: null }),
    });
    expect(evaluation.acceptanceState).toBe("pending-acceptance");
    expect(evaluation.blockReasonCodes).toContain("review-task-not-completed");
  });

  it("审查任务完成但**没有裁决** ⇒ pending-acceptance", () => {
    const evaluation = evaluateIndependentReview({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: buildReviewOutcome({ verdict: null }),
    });
    expect(evaluation.acceptanceState).toBe("pending-acceptance");
    expect(evaluation.blockReasonCodes).toContain("verdict-missing");
  });

  it("裁决 rework ⇒ **返修**，且不得宣称完成", () => {
    const evaluation = evaluateIndependentReview({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: buildReviewOutcome({ verdict: "rework" }),
    });
    expect(evaluation.acceptanceState).toBe("rework");
    expect(evaluation.blockReasonCodes).toContain("verdict-rejected");
    expect(isFinalCompletionAllowed(evaluation.acceptanceState)).toBe(false);
  });

  it("merge-ready 但**无证据** ⇒ 降级为 pending-acceptance（不算通过）", () => {
    const evaluation = evaluateIndependentReview({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: buildReviewOutcome({ evidenceReferences: [] }),
    });
    expect(evaluation.acceptanceState).toBe("pending-acceptance");
    expect(evaluation.blockReasonCodes).toContain("verdict-evidence-missing");
  });

  it("真实审查任务完成 + merge-ready + 有证据 ⇒ **accepted**，才允许宣称完成", () => {
    const evaluation = evaluateIndependentReview({
      isArtifactPreconditionSatisfied: true,
      reviewOutcome: buildReviewOutcome(),
    });
    expect(evaluation.acceptanceState).toBe("accepted");
    expect(evaluation.blockReasonCodes).toEqual([]);
    expect(isFinalCompletionAllowed(evaluation.acceptanceState)).toBe(true);
  });

  it("四态到用户措辞的映射唯一（不出现含糊的\"已完成\"）", () => {
    expect(describeAcceptanceState("execution-done")).toBe("执行完成（尚未送审）");
    expect(describeAcceptanceState("pending-acceptance")).toBe("待验收（审查中）");
    expect(describeAcceptanceState("rework")).toBe("返修");
    expect(describeAcceptanceState("accepted")).toBe("验收通过");
    expect(describeAcceptanceState("pending-acceptance")).not.toContain("完成");
  });
});

describe("ALIGN-03-01 禁止回归：产物存在不得直接产出验收通过", () => {
  it("主控制器不再使用\"产物即结论\"的旧模块", async () => {
    const { readFileSync } = await import("node:fs");
    const controllerSource = readFileSync(
      new URL(
        "../../packages/core/src/orchestration/main-controller.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(controllerSource).not.toContain("produceArtifactBackedVerdict");
    expect(controllerSource).toContain("evaluateArtifactPrecondition");
    /** 产物前置满足时必须**直接返回**（等待真实审查任务），而不是写裁决。 */
    expect(controllerSource).toContain("if (artifactPrecondition.isSatisfied)");
  });

  it("产物前置模块的类型里**不存在** merge-ready 这个值", async () => {
    const { readFileSync } = await import("node:fs");
    const preconditionSource = readFileSync(
      new URL(
        "../../packages/core/src/orchestration/artifact-precondition.ts",
        import.meta.url,
      ),
      "utf8",
    );
    /** 注释里会提到这个词（说明它被排除），但**类型上**不得有裁决字段。 */
    expect(preconditionSource).not.toContain("readonly verdict");
    expect(preconditionSource).not.toContain("verdict: \"merge-ready\"");
  });
});