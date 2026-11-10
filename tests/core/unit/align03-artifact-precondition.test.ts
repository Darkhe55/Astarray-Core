/**
 * ALIGN-03-01（2026-11-10 方案 C）：**产物前置检查**（不是验收结论）。
 *
 * 送审产物取自**完成收据**（`completion-receipt.ts` 的 `artifactPaths`），不读 `resultLocation`。
 * 钉住：多产物任一存在即可送审；全部不可确认 ⇒ 不满足；类型上**没有** verdict 字段。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateArtifactPrecondition } from "../../../packages/core/src/orchestration/artifact-precondition.js";

vi.setConfig({ testTimeout: 30_000 });

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-artifact-precondition-"));
  await fs.mkdir(path.join(projectRootPath, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 10 });
});

describe("ALIGN-03-01 产物前置检查（收据来源）", () => {
  it("单条产物存在且非空 ⇒ 可送审，证据是 artifact: 前缀", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "内容", "utf8");
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      artifactPaths: ["docs/out.md"],
    });
    expect(precondition.isSatisfied).toBe(true);
    expect(precondition.confirmedArtifactPaths).toEqual(["docs/out.md"]);
    expect(precondition.evidenceReferences).toContain("artifact:docs/out.md");
    expect(precondition.failureCheckReference).toBeNull();
    expect("verdict" in precondition).toBe(false);
  });

  it("**多条**产物：任一条存在即可送审，只确认存在的那条", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "b.md"), "内容", "utf8");
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      artifactPaths: ["docs/a.md", "docs/b.md"],
    });
    expect(precondition.isSatisfied).toBe(true);
    expect(precondition.confirmedArtifactPaths).toEqual(["docs/b.md"]);
  });

  it("收据**没有**产物路径 ⇒ 不满足 + artifact-paths-unregistered", async () => {
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      artifactPaths: [],
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.failureCheckReference).toBe("check:artifact-paths-unregistered");
  });

  it("全部产物都不可确认 ⇒ 不满足，失败引用逐条给出", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "empty.md"), "", "utf8");
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      artifactPaths: ["docs/empty.md", "docs/missing.md"],
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.evidenceReferences).toContain("check:artifact-empty:docs/empty.md");
    expect(precondition.evidenceReferences).toContain("check:artifact-missing:docs/missing.md");
  });

  it("越界路径不算可送审", async () => {
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      artifactPaths: ["../escape.md"],
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.failureCheckReference).toContain("outside-project-root");
  });
});
