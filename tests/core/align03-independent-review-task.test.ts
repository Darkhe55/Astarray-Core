/**
 * ALIGN-03-01（2026-11-10 续）：**真实审查任务**的节点构造与报告解析。
 *
 * 钉住四件事：
 *  ① 审查任务是真实节点（`taskType: "review"`、依赖执行任务、指派给审查者）；
 *  ② 报告解析只认 `VERDICT:` / `EVIDENCE:` 行；
 *  ③ 报告不合规（无裁决行 / 通过但无证据）⇒ 解析返回 null，调用方必须按未通过处理；
 *  ④ 审查任务节点**不能**再派生审查任务（防递归）——由调用方按 taskType 判断。
 */
import { describe, expect, it } from "vitest";

import {
  buildReviewTaskIdentifier,
  buildReviewTaskNode,
  parseReviewVerdictReport,
} from "../../packages/core/src/orchestration/independent-review-task.js";

describe("ALIGN-03-01 真实审查任务节点", () => {
  it("节点是真实任务：review 类型、依赖执行任务、指派审查者、pending", () => {
    const node = buildReviewTaskNode({
      reviewedTaskIdentifier: "T-1",
      reviewerAgentInstanceId: "reviewer:mission-1:T-1",
      acceptanceCriteria: "产物为 docs/out.md 且测试通过",
    });
    expect(node.id).toBe(buildReviewTaskIdentifier("T-1"));
    expect(node.id).toBe("review:T-1");
    expect(node.taskType).toBe("review");
    expect(node.dependsOn).toEqual(["T-1"]);
    expect(node.assignedAgentId).toBe("reviewer:mission-1:T-1");
    expect(node.status).toBe("pending");
    expect(node.resultLocation).toBeNull();
    expect(node.acceptanceCriteria).toContain("docs/out.md");
  });

  it("任务描述里写明报告格式（审查者才知道要产出什么）", () => {
    const node = buildReviewTaskNode({
      reviewedTaskIdentifier: "T-1",
      reviewerAgentInstanceId: "reviewer:1",
      acceptanceCriteria: null,
    });
    expect(node.description).toContain("VERDICT:");
    expect(node.description).toContain("EVIDENCE:");
    expect(node.description).toContain("T-1");
  });

  it("同一执行任务的审查任务标识**幂等**（不会派生第二个）", () => {
    expect(buildReviewTaskIdentifier("T-9")).toBe(buildReviewTaskIdentifier("T-9"));
  });
});

describe("ALIGN-03-01 审查报告解析", () => {
  it("`VERDICT: accept` + 证据 ⇒ merge-ready", () => {
    const parsed = parseReviewVerdictReport(
      ["审查结论", "VERDICT: accept", "EVIDENCE: artifact:docs/out.md", "EVIDENCE: test:vitest"].join(
        "\n",
      ),
    );
    expect(parsed?.verdict).toBe("merge-ready");
    expect(parsed?.evidenceReferences).toEqual(["artifact:docs/out.md", "test:vitest"]);
  });

  it("`VERDICT: rework` ⇒ rework（即使带了证据）", () => {
    const parsed = parseReviewVerdictReport("VERDICT: rework\nEVIDENCE: check:artifact-empty");
    expect(parsed?.verdict).toBe("rework");
    expect(parsed?.evidenceReferences).toEqual(["check:artifact-empty"]);
  });

  it("**没有裁决行** ⇒ null（调用方按未通过处理）", () => {
    expect(parseReviewVerdictReport("产物看起来没问题，我觉得可以。")).toBeNull();
  });

  it("裁决值非法（如 maybe）⇒ null", () => {
    expect(parseReviewVerdictReport("VERDICT: maybe")).toBeNull();
  });

  it("**判定通过但没有证据** ⇒ null（不能只凭一句话通过）", () => {
    expect(parseReviewVerdictReport("VERDICT: accept")).toBeNull();
  });

  it("大小写与前后的空白不影响解析", () => {
    const parsed = parseReviewVerdictReport("  verdict:   ACCEPT  \n  evidence:  commit:abc1234 ");
    expect(parsed?.verdict).toBe("merge-ready");
    expect(parsed?.evidenceReferences).toEqual(["commit:abc1234"]);
  });

  it("多行裁决只取第一行（后写的不覆盖先写的）", () => {
    const parsed = parseReviewVerdictReport(
      "VERDICT: rework\nVERDICT: accept\nEVIDENCE: x",
    );
    expect(parsed?.verdict).toBe("rework");
  });
});
