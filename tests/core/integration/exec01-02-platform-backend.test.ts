/**
 * EXEC-01-02（2026-11-09）：按平台装配默认沙箱后端的**判定规则**。
 *
 * 裁决要求"默认隔离不可用时禁止静默退回无限制宿主执行"。
 * 因此本文件钉住：找不到组件 ⇒ 返回 `null`（而不是一个"凑合能用"的后端）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPlatformSandboxExecutionBackend,
  resolveSandboxHelperExecutablePath,
} from "../../../packages/core/src/execution/platform-sandbox-backend.js";

let temporaryRootPath: string;

beforeEach(async () => {
  temporaryRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-platform-backend-"));
});

afterEach(async () => {
  await fs.rm(temporaryRootPath, { recursive: true, force: true, maxRetries: 10 });
});

describe("EXEC-01-02 默认后端装配", () => {
  it("没有辅助程序 ⇒ 解析为 null，且不构造任何后端（不降级到宿主执行）", () => {
    const helperExecutablePath = resolveSandboxHelperExecutablePath({
      applicationRootPath: temporaryRootPath,
    });
    expect(helperExecutablePath).toBeNull();
    expect(
      createPlatformSandboxExecutionBackend({ applicationRootPath: temporaryRootPath }),
    ).toBeNull();
  }, 30_000);

  it("显式覆盖指向不存在的文件 ⇒ 同样为 null（不假设可用）", () => {
    expect(
      resolveSandboxHelperExecutablePath({
        applicationRootPath: temporaryRootPath,
        helperExecutablePathOverride: path.join(temporaryRootPath, "missing-helper.exe"),
      }),
    ).toBeNull();
  }, 30_000);

  it("显式覆盖指向真实文件 ⇒ 解析出该路径并构造后端", async () => {
    const fakeHelperPath = path.join(temporaryRootPath, "fake-helper.exe");
    await fs.writeFile(fakeHelperPath, "", "utf8");
    const resolved = resolveSandboxHelperExecutablePath({
      applicationRootPath: temporaryRootPath,
      helperExecutablePathOverride: fakeHelperPath,
    });
    expect(resolved).toBe(fakeHelperPath);
    expect(
      createPlatformSandboxExecutionBackend({
        applicationRootPath: temporaryRootPath,
        helperExecutablePathOverride: fakeHelperPath,
      }),
    ).not.toBeNull();
  }, 30_000);
});
