/**
 * ALIGN-03-01（2026-11-10 修订）：**产物前置检查**（不是验收结论）。
 *
 * 用户裁决：产物"存在且非空"不得直接算 `merge-ready`。
 * 本文件钉住新的契约：
 *  - 前置检查结果**没有** `merge-ready` 这个值（类型上就不存在）；
 *  - 满足 ⇒ `isSatisfied=true` + `artifact:` 证据（可送审）；
 *  - 不满足 ⇒ `isSatisfied=false` + `check:` 前缀的**检查结果**证据（可写进返修单）；
 *  - 缺产物**不抛错**（未产出 ≠ 审查失败）。
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

describe("ALIGN-03-01 产物前置检查", () => {
  it("产物存在且非空 ⇒ 可送审，证据是 artifact: 前缀", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "内容", "utf8");
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      resultLocation: "docs/out.md",
    });
    expect(precondition.isSatisfied).toBe(true);
    expect(precondition.evidenceReferences[0]).toBe("artifact:docs/out.md");
    expect(precondition.failureCheckReference).toBeNull();
    /** 关键：**没有** verdict 字段，产物存在不能表达成"通过"。 */
    expect("verdict" in precondition).toBe(false);
  });

  it("空产物 ⇒ 不满足，检查引用可写进返修单", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "", "utf8");
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      resultLocation: "docs/out.md",
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.failureCheckReference).toContain("check:artifact-empty");
  });

  it("产物缺失 ⇒ 不满足且**不抛错**（未产出 ≠ 审查失败）", async () => {
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      resultLocation: "docs/missing.md",
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.failureCheckReference).toContain("check:artifact-missing");
  });

  it("未登记产物路径 ⇒ 不满足，检查引用为 result-location-unregistered", async () => {
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      resultLocation: null,
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.failureCheckReference).toBe("check:result-location-unregistered");
  });

  it("越界路径 ⇒ 不满足（outside-project-root），不当成可送审", async () => {
    const precondition = await evaluateArtifactPrecondition({
      projectRootPath,
      resultLocation: "../escape.md",
    });
    expect(precondition.isSatisfied).toBe(false);
    expect(precondition.failureCheckReference).toContain("outside-project-root");
  });
});
