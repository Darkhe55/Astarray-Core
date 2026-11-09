/**
 * ALIGN-04-03（2026-11-10）：**产物校验**（有路径 ≠ 有产物）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkOutputArtifact,
  isOutputArtifactConfirmed,
} from "../../../packages/core/src/orchestration/output-artifact-check.js";

vi.setConfig({ testTimeout: 30_000 });

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-artifact-"));
  await fs.mkdir(path.join(projectRootPath, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 10 });
});

describe("ALIGN-04-03 产物校验", () => {
  it("产物存在且非空 ⇒ present，并给出字节数", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "out.md"), "内容", "utf8");
    const check = await checkOutputArtifact({
      projectRootPath,
      resultLocation: "docs/out.md",
    });
    expect(check.kind).toBe("present");
    expect(isOutputArtifactConfirmed(check)).toBe(true);
  }, 30_000);

  it("**路径记了但文件不存在** ⇒ missing（不得当成已产出）", async () => {
    const check = await checkOutputArtifact({
      projectRootPath,
      resultLocation: "docs/missing.md",
    });
    expect(check.kind).toBe("missing");
    expect(isOutputArtifactConfirmed(check)).toBe(false);
  }, 30_000);

  it("**空文件** ⇒ empty（有文件不等于有产出）", async () => {
    await fs.writeFile(path.join(projectRootPath, "docs", "empty.md"), "", "utf8");
    const check = await checkOutputArtifact({
      projectRootPath,
      resultLocation: "docs/empty.md",
    });
    expect(check.kind).toBe("empty");
    expect(isOutputArtifactConfirmed(check)).toBe(false);
  }, 30_000);

  it("**路径越界** ⇒ outside-project-root（不读项目外的东西）", async () => {
    for (const resultLocation of ["../outside.md", "/etc/passwd", "docs/../../outside.md"]) {
      const check = await checkOutputArtifact({ projectRootPath, resultLocation });
      expect(check.kind).toBe("outside-project-root");
    }
  }, 30_000);

  it("目录不是产物 ⇒ missing（不把目录当文件）", async () => {
    await fs.mkdir(path.join(projectRootPath, "docs", "subdirectory"));
    const check = await checkOutputArtifact({
      projectRootPath,
      resultLocation: "docs/subdirectory",
    });
    expect(check.kind).toBe("missing");
  }, 30_000);

  it("空 resultLocation ⇒ missing", async () => {
    const check = await checkOutputArtifact({ projectRootPath, resultLocation: "   " });
    expect(check.kind).toBe("missing");
  }, 30_000);

  it("项目根本身不是产物 ⇒ outside-project-root（不把根当产物）", async () => {
    const check = await checkOutputArtifact({ projectRootPath, resultLocation: "." });
    expect(check.kind).toBe("outside-project-root");
  }, 30_000);
});
