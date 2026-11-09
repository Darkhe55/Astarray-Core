/**
 * ALIGN-03-01（2026-11-10）：**产物证据驱动的验收结论**。
 *
 * 卡内要求："同一执行任务的自报不能代替独立审查结论"。
 * 本文件钉住：结论只依据可复核产物；缺产物 ⇒ rework（不抛错、不谎报完成）；
 * 证据前缀**不是**自报类前缀（否则会被独立验收门禁拒绝）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { produceArtifactBackedVerdict } from "../../../packages/core/src/orchestration/artifact-backed-verdict.js";

vi.setConfig({ testTimeout: 30_000 });

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-artifact-verdict-"));
  await fs.mkdir(path.join(projectRootPath, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 10 });
});

describe("ALIGN-03-01 产物证据验收结论", () => {
  it("产物存在且非空 ⇒ merge-ready，证据是 artifact: 前缀", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "内容", "utf8");
    const verdict = await produceArtifactBackedVerdict({
      projectRootPath,
      taskIdentifier: "T-1",
      taskRevision: 1,
      resultLocation: "docs/out.md",
    });
    expect(verdict.verdict).toBe("merge-ready");
    expect(verdict.evidenceReferences[0]).toBe("artifact:docs/out.md");
    expect(verdict.evidenceReferences.some((ref) => ref.startsWith("self-report:"))).toBe(
      false,
    );
  }, 30_000);

  it("**产物缺失 ⇒ rework**（不抛错、不谎报完成）", async () => {
    const verdict = await produceArtifactBackedVerdict({
      projectRootPath,
      taskIdentifier: "T-1",
      taskRevision: 1,
      resultLocation: "docs/missing.md",
    });
    expect(verdict.verdict).toBe("rework");
    expect(verdict.reason).toContain("不可确认");
    expect(verdict.evidenceReferences).toEqual([]);
  }, 30_000);

  it("空产物 ⇒ rework（有文件不等于有产出）", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "empty.md"), "", "utf8");
    const verdict = await produceArtifactBackedVerdict({
      projectRootPath,
      taskIdentifier: "T-1",
      taskRevision: 1,
      resultLocation: "docs/empty.md",
    });
    expect(verdict.verdict).toBe("rework");
  }, 30_000);

  it("未登记产物路径 ⇒ rework（没有可复核的产出）", async () => {
    const verdict = await produceArtifactBackedVerdict({
      projectRootPath,
      taskIdentifier: "T-1",
      taskRevision: 1,
      resultLocation: null,
    });
    expect(verdict.verdict).toBe("rework");
    expect(verdict.reason).toContain("未登记产物路径");
  }, 30_000);

  it("越界路径 ⇒ rework（不读项目外的东西）", async () => {
    const verdict = await produceArtifactBackedVerdict({
      projectRootPath,
      taskIdentifier: "T-1",
      taskRevision: 1,
      resultLocation: "../outside.md",
    });
    expect(verdict.verdict).toBe("rework");
    expect(verdict.reason).toContain("outside-project-root");
  }, 30_000);

  it("给出提交哈希 ⇒ 证据里带 commit:", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "内容", "utf8");
    const verdict = await produceArtifactBackedVerdict({
      projectRootPath,
      taskIdentifier: "T-1",
      taskRevision: 1,
      resultLocation: "docs/out.md",
      boundCommitHash: "abc123",
    });
    expect(verdict.evidenceReferences).toContain("commit:abc123");
  }, 30_000);
});
