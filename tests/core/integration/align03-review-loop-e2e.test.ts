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

vi.setConfig({ testTimeout: 120_000 });

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

describe("ALIGN-03-01 任务级闭环（devolve 装配已接钩子）", () => {
  it("写工具产出后，任务链出现 review:* 节点，且描述里列出该产物", async () => {
    const { createApplicationRuntime } = await import(
      "../../../packages/core/src/application/application-runtime.js"
    );
    const { ScriptedRuntime } = await import(
      "../../../packages/core/src/runtime/scripted-runtime.js"
    );
    let workerIndex = 0;
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-review-mission-"));
    const missionProjectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "astarray-review-mission-p-"),
    );
    const runtime = await createApplicationRuntime({
      mode: "devolve",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 6,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      /**
       * 第 1 个 Worker = 执行任务（写 `out.md`）；
       * 第 2 个 Worker = 审查任务（写报告并给出 `VERDICT: accept`）。
       * 步序必须是 tool-call → finish(tool-calls) → text → finish(success)。
       */
      workerRuntimeFactory: () => {
        workerIndex += 1;
        const filePath = workerIndex === 1 ? "out.md" : "review.md";
        const content =
          workerIndex === 1
            ? "已产出"
            : "VERDICT: accept\nEVIDENCE: artifact:out.md\n";
        return new ScriptedRuntime([
          {
            type: "tool-call",
            toolName: "createProjectFile",
            argumentsJson: JSON.stringify({ filePath, content }),
            callId: `call-${String(workerIndex)}`,
          },
          { type: "finish", reason: "tool-calls", detail: "请求工具" },
          { type: "text", text: "已完成。" },
          { type: "finish", reason: "success", detail: "完成" },
        ]);
      },
      isIndependentReviewAutoAppointmentEnabled: true,
      projectIdentifier: "project-alpha",
      workspaceRootPath: missionProjectRoot,
    });
    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("任务级闭环", {
        projectIdentifier: "project-alpha",
      });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = (await runtime.controller.queryMissionStatus(missionIdentifier))?.summary
          ?.status;
        if (status === "done" || status === "blocked" || status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const chain = await runtime.taskStore.readTaskChain(missionIdentifier);
      const isFileCreated = await fs
        .readFile(path.join(missionProjectRoot, "out.md"), "utf8")
        .then(() => true)
        .catch(() => false);
      const reviewNodes = (chain?.tasks ?? []).filter((node) => node.taskType === "review");
      expect(
        reviewNodes.length,
        JSON.stringify({
          tasks: (chain?.tasks ?? []).map((node) => [node.id, node.taskType, node.status]),
          isFileCreated,
        }),
      ).toBeGreaterThan(0);
      expect(reviewNodes[0]?.description).toContain("EVIDENCE: artifact:out.md");
      /** 最后一环：审查报告 ⇒ 裁决落盘（accepted / merge-ready）。 */
      const verdictDirectoryPath = path.join(stateDirectory, "completion-verdicts");
      const readAllVerdictFiles = async (directoryPath: string): Promise<string[]> => {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
        const collected: string[] = [];
        for (const entry of entries) {
          const entryPath = path.join(directoryPath, entry.name);
          if (entry.isDirectory()) {
            collected.push(...(await readAllVerdictFiles(entryPath)));
            continue;
          }
          collected.push(await fs.readFile(entryPath, "utf8").catch(() => ""));
        }
        return collected;
      };
      /** 裁决落盘是异步的：轮询等待，直到出现 accepted 或超过 20 秒。 */
      let verdictText = "";
      const verdictDeadline = Date.now() + 20_000;
      while (Date.now() < verdictDeadline) {
        verdictText = (await readAllVerdictFiles(verdictDirectoryPath)).join("\n");
        if (verdictText.includes("accepted")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(verdictText, verdictText.slice(0, 500)).toContain("accepted");
      /**
       * 记录里只留裁决与理由（不含证据列表）；"accepted" 本身即证明报告证据命中了送审产物，
       * 因为证据不匹配会被 `resolveReviewVerdict` 判成 rework。
       */
      expect(verdictText).toContain("reviewer:mission-");
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
      await fs.rm(missionProjectRoot, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 120_000);
});