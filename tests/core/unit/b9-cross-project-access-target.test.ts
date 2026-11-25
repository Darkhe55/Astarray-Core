/**
 * B9（2026-11-25）：跨项目访问目标校验（**先自证再 I/O**）。
 *
 * 契约：调用方声称要访问相对路径，实际打开的对象必须与解析结果**是同一个文件**；
 * 否则拒绝（access-target-mismatch / 不存在），避免"先读后判"绕过授权范围。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertCrossProjectAccessTargetIsAuthorized } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cross-access-"));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("B9：跨项目访问目标校验", () => {
  it("① 声明与实际是同一文件 ⇒ 允许并返回解析路径", async () => {
    const declared = path.join(projectRoot, "docs", "a.txt");
    await fs.mkdir(path.dirname(declared), { recursive: true });
    await fs.writeFile(declared, "内容", "utf8");

    const outcome = await assertCrossProjectAccessTargetIsAuthorized({
      projectRootPath: projectRoot,
      relativeResourcePath: path.join("docs", "a.txt"),
      absoluteResourcePath: declared,
      label: "跨项目读取：",
    });
    expect(outcome.isAllowed).toBe(true);
    if (outcome.isAllowed) {
      expect(path.basename(outcome.resolvedAbsolutePath)).toBe("a.txt");
    }
  });

  it("② 声明 a.txt 实际访问 c.txt ⇒ 拒绝（access-target-mismatch）", async () => {
    const declared = path.join(projectRoot, "docs", "a.txt");
    const actual = path.join(projectRoot, "docs", "c.txt");
    await fs.mkdir(path.dirname(declared), { recursive: true });
    await fs.writeFile(declared, "a", "utf8");
    await fs.writeFile(actual, "c", "utf8");

    const outcome = await assertCrossProjectAccessTargetIsAuthorized({
      projectRootPath: projectRoot,
      relativeResourcePath: path.join("docs", "a.txt"),
      absoluteResourcePath: actual,
      label: "跨项目读取：",
    });
    expect(outcome.isAllowed).toBe(false);
    if (!outcome.isAllowed) {
      expect(outcome.detail).toContain("access-target-mismatch");
    }
  });

  it("③ 声明与实际同一个不存在的路径 ⇒ 允许，但解析到最近存在祖先下的同一路径", async () => {
    /** 设计：用"最近存在祖先 + 剩余段"规范化，因此同一条不存在路径两侧一致即放行，由后续读取失败。 */
    const outcome = await assertCrossProjectAccessTargetIsAuthorized({
      projectRootPath: projectRoot,
      relativeResourcePath: "docs/missing.txt",
      absoluteResourcePath: path.join(projectRoot, "docs", "missing.txt"),
      label: "跨项目读取：",
    });
    expect(outcome.isAllowed).toBe(true);
    if (outcome.isAllowed) {
      expect(outcome.resolvedAbsolutePath.endsWith(path.join("docs", "missing.txt"))).toBe(true);
    }
  });

  it("④ 声明存在文件、实际不存在路径 ⇒ 拒绝", async () => {
    const declared = path.join(projectRoot, "docs", "a.txt");
    await fs.mkdir(path.dirname(declared), { recursive: true });
    await fs.writeFile(declared, "a", "utf8");
    const outcome = await assertCrossProjectAccessTargetIsAuthorized({
      projectRootPath: projectRoot,
      relativeResourcePath: path.join("docs", "a.txt"),
      absoluteResourcePath: path.join(projectRoot, "docs", "missing.txt"),
      label: "跨项目读取：",
    });
    expect(outcome.isAllowed).toBe(false);
  });
});
