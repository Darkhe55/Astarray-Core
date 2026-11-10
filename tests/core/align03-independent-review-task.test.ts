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
  decideIndependentReview,
  parseReviewArtifactPathsFromDescription,
  parseReviewVerdictReport,
  resolveReviewVerdict,
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

describe("ALIGN-03-01 裁决只能来自审查报告（含真实文件）", () => {
  it("报告写明 accept + 证据 ⇒ merge-ready，证据含报告引用", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "astarray-review-report-"));
    try {
      await writeFile(
        join(root, "review.md"),
        "VERDICT: accept\nEVIDENCE: artifact:docs/out.md\n",
        "utf8",
      );
      const resolved = await resolveReviewVerdict({
        projectRootPath: root,
        reviewTaskIdentifier: "review:T-1",
        resultLocation: "review.md",
        reviewOutcome: "success",
      });
      expect(resolved.verdict).toBe("merge-ready");
      expect(resolved.evidenceReferences[0]).toBe("review-report:review.md");
      expect(resolved.evidenceReferences).toContain("artifact:docs/out.md");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it("审查任务**失败** ⇒ rework（不读报告、不默认通过）", async () => {
    const resolved = await resolveReviewVerdict({
      projectRootPath: "/nonexistent-root",
      reviewTaskIdentifier: "review:T-1",
      resultLocation: "review.md",
      reviewOutcome: "failure",
    });
    expect(resolved.verdict).toBe("rework");
    expect(resolved.evidenceReferences).toEqual(["check:review-task-failed:review:T-1"]);
  });

  it("未登记报告路径 ⇒ rework + review-report-unregistered", async () => {
    const resolved = await resolveReviewVerdict({
      projectRootPath: "/nonexistent-root",
      reviewTaskIdentifier: "review:T-1",
      resultLocation: null,
      reviewOutcome: "success",
    });
    expect(resolved.verdict).toBe("rework");
    expect(resolved.evidenceReferences[0]).toContain("check:review-report-unregistered");
  });

  it("报告不可读 ⇒ rework + review-report-unreadable", async () => {
    const resolved = await resolveReviewVerdict({
      projectRootPath: "/nonexistent-root",
      reviewTaskIdentifier: "review:T-1",
      resultLocation: "missing.md",
      reviewOutcome: "success",
    });
    expect(resolved.verdict).toBe("rework");
    expect(resolved.evidenceReferences[0]).toContain("check:review-report-unreadable");
  });

  it("报告**没有裁决行** ⇒ rework + review-verdict-missing（绝不默认通过）", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "astarray-review-report-"));
    try {
      await writeFile(join(root, "review.md"), "看起来可以。", "utf8");
      const resolved = await resolveReviewVerdict({
        projectRootPath: root,
        reviewTaskIdentifier: "review:T-1",
        resultLocation: "review.md",
        reviewOutcome: "success",
      });
      expect(resolved.verdict).toBe("rework");
      expect(resolved.evidenceReferences[0]).toContain("check:review-verdict-missing");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});
describe("ALIGN-03-01 报告证据必须引用本次送审产物（方案 C）", () => {
  it("证据引用了送审产物 ⇒ merge-ready", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "astarray-review-evidence-"));
    try {
      await writeFile(join(root, "r.md"), "VERDICT: accept\nEVIDENCE: artifact:docs/out.md\n", "utf8");
      const resolved = await resolveReviewVerdict({
        projectRootPath: root,
        reviewTaskIdentifier: "review:T-1",
        resultLocation: "r.md",
        reviewOutcome: "success",
        expectedArtifactPaths: ["docs/out.md"],
      });
      expect(resolved.verdict).toBe("merge-ready");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it("证据引用了**别的文件** ⇒ rework + review-evidence-mismatch（防冒充）", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "astarray-review-evidence-"));
    try {
      await writeFile(join(root, "r.md"), "VERDICT: accept\nEVIDENCE: artifact:docs/other.md\n", "utf8");
      const resolved = await resolveReviewVerdict({
        projectRootPath: root,
        reviewTaskIdentifier: "review:T-1",
        resultLocation: "r.md",
        reviewOutcome: "success",
        expectedArtifactPaths: ["docs/out.md"],
      });
      expect(resolved.verdict).toBe("rework");
      expect(resolved.evidenceReferences[0]).toContain("check:review-evidence-mismatch");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it("审查任务描述里的送审产物可被取回（控制器据此校验）", () => {
    const node = buildReviewTaskNode({
      reviewedTaskIdentifier: "T-1",
      reviewerAgentInstanceId: "reviewer:1",
      acceptanceCriteria: null,
      artifactPaths: ["docs/out.md", "docs/report.md"],
    });
    expect(parseReviewArtifactPathsFromDescription(node.description)).toEqual([
      "docs/out.md",
      "docs/report.md",
    ]);
  });
});
describe("ALIGN-03-01 完成后的下一步决策（可测的派发分支）", () => {
  it("收据有真实产物 ⇒ **派发审查任务**，且审查任务里列出该产物", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "astarray-review-dispatch-"));
    try {
      await writeFile(join(root, "out.md"), "内容", "utf8");
      const decision = await decideIndependentReview({
        projectRootPath: root,
        missionId: "m-1",
        taskId: "T-1",
        reviewerAgentInstanceId: "reviewer:m-1:T-1",
        acceptanceCriteria: "产物为 out.md",
        artifactPaths: ["out.md"],
      });
      expect(decision.kind).toBe("dispatch-review");
      if (decision.kind !== "dispatch-review") throw new Error("unreachable");
      expect(decision.reviewTask.taskType).toBe("review");
      expect(decision.reviewTask.assignedAgentId).toBe("reviewer:m-1:T-1");
      expect(decision.reviewTask.description).toContain("EVIDENCE: artifact:out.md");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it("收据产物缺失 ⇒ **返修**，不派发审查任务", async () => {
    const decision = await decideIndependentReview({
      projectRootPath: "/nonexistent-root",
      missionId: "m-1",
      taskId: "T-1",
      reviewerAgentInstanceId: "reviewer:m-1:T-1",
      acceptanceCriteria: null,
      artifactPaths: ["missing.md"],
    });
    expect(decision.kind).toBe("record-rework");
  });

  it("收据没有任何产物 ⇒ 返修 + artifact-paths-unregistered", async () => {
    const decision = await decideIndependentReview({
      projectRootPath: "/nonexistent-root",
      missionId: "m-1",
      taskId: "T-1",
      reviewerAgentInstanceId: "reviewer:m-1:T-1",
      acceptanceCriteria: null,
      artifactPaths: [],
    });
    expect(decision.kind).toBe("record-rework");
    if (decision.kind !== "record-rework") throw new Error("unreachable");
    expect(decision.evidenceReferences).toContain("check:artifact-paths-unregistered");
  });
});