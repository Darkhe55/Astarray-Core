/**
 * ALIGN-03-01（2026-11-10）：**闭环组合测试**——收据产物 ⇒ 派发审查 ⇒ 报告裁决。
 *
 * 为什么这样测（而不是任务级 e2e）：
 * 任务级装配里 `createProjectFile` 没有被真正执行（实测裁决文件写"完成收据未记录任何落盘产物"），
 * 该差别在**任务装配/权限**层，不在收据与裁决逻辑。因此这里用**真实文件**串起三段：
 *
 *   ① 收据里的相对路径（`docs/out.md`）能在项目根下被前置检查确认；
 *   ② 确认后产出**审查任务**，描述里带上该产物（审查者据此复核）；
 *   ③ 审查报告写了 `VERDICT: accept` + 命中该产物的 `EVIDENCE` ⇒ 裁决 `merge-ready`；
 *      写 `VERDICT: rework` 或引用了别的文件 ⇒ 裁决 `rework`（不得宣称通过）。
 *
 * 未覆盖：调度器把审查任务真正派给 Worker 并回收这一跳（由 `align03-auto-review-appointment` 覆盖装配面）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decideIndependentReview,
  parseReviewArtifactPathsFromDescription,
  resolveReviewVerdict,
} from "../../../packages/core/src/orchestration/independent-review-task.js";

vi.setConfig({ testTimeout: 60_000 });

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-review-loop-"));
  await fs.mkdir(path.join(projectRootPath, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 10 });
});

describe("ALIGN-03-01 闭环组合（收据 ⇒ 派发 ⇒ 裁决）", () => {
  it("收据产物存在 ⇒ 派发审查任务；报告引用该产物 ⇒ merge-ready", async () => {
    /** ① Worker 实际落盘的相对路径（与收据里记录的形态一致）。 */
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "产物内容", "utf8");
    const receiptArtifactPaths = ["docs/out.md"];

    /** ② 派发决策：应产出审查任务，而不是直接给结论。 */
    const decision = await decideIndependentReview({
      projectRootPath,
      missionId: "mission-1",
      taskId: "T-1",
      reviewerAgentInstanceId: "reviewer:mission-1:T-1",
      acceptanceCriteria: "产物为 docs/out.md",
      artifactPaths: receiptArtifactPaths,
    });
    expect(decision.kind).toBe("dispatch-review");
    if (decision.kind !== "dispatch-review") throw new Error("unreachable");
    expect(decision.reviewTask.taskType).toBe("review");
    expect(parseReviewArtifactPathsFromDescription(decision.reviewTask.description)).toEqual([
      "docs/out.md",
    ]);

    /** ③ 审查者写报告（引用同一产物）⇒ 裁决通过。 */
    await fs.writeFile(
      path.join(projectRootPath, "review.md"),
      "VERDICT: accept\nEVIDENCE: artifact:docs/out.md\n",
      "utf8",
    );
    const resolved = await resolveReviewVerdict({
      projectRootPath,
      reviewTaskIdentifier: decision.reviewTask.id,
      resultLocation: "review.md",
      reviewOutcome: "success",
      expectedArtifactPaths: receiptArtifactPaths,
    });
    expect(resolved.verdict).toBe("merge-ready");
    expect(resolved.evidenceReferences).toContain("review-report:review.md");
  });

  it("审查报告判定返修 ⇒ rework（不得宣称通过）", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "产物内容", "utf8");
    await fs.writeFile(
      path.join(projectRootPath, "review.md"),
      "VERDICT: rework\nEVIDENCE: check:artifact-empty:docs/other.md\n",
      "utf8",
    );
    const resolved = await resolveReviewVerdict({
      projectRootPath,
      reviewTaskIdentifier: "review:T-1",
      resultLocation: "review.md",
      reviewOutcome: "success",
      expectedArtifactPaths: ["docs/out.md"],
    });
    expect(resolved.verdict).toBe("rework");
  });

  it("**审查任务失败** ⇒ rework（不读报告、不默认通过）", async () => {
    const resolved = await resolveReviewVerdict({
      projectRootPath,
      reviewTaskIdentifier: "review:T-1",
      resultLocation: "review.md",
      reviewOutcome: "failure",
      expectedArtifactPaths: ["docs/out.md"],
    });
    expect(resolved.verdict).toBe("rework");
  });

  it("**报告缺失** ⇒ rework（不宣称完成）", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "产物内容", "utf8");
    const resolved = await resolveReviewVerdict({
      projectRootPath,
      reviewTaskIdentifier: "review:T-1",
      resultLocation: "no-such-report.md",
      reviewOutcome: "success",
      expectedArtifactPaths: ["docs/out.md"],
    });
    expect(resolved.verdict).toBe("rework");
    expect(resolved.evidenceReferences[0]).toContain("check:review-report-unreadable");
  });

  it("收据产物不存在 ⇒ **不派发**审查任务，直接返修", async () => {
    const decision = await decideIndependentReview({
      projectRootPath,
      missionId: "mission-1",
      taskId: "T-1",
      reviewerAgentInstanceId: "reviewer:mission-1:T-1",
      acceptanceCriteria: null,
      artifactPaths: ["docs/never-written.md"],
    });
    expect(decision.kind).toBe("record-rework");
  });
});
