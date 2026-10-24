/**
 * 文件夹授权扩展工具边界（用户口径 A，2026-10-24）。
 * 授权根只在 provider 返回时生效；provider 抛错 ⇒ 只保留主根（fail-closed）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

const temporaryDirectories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-boundary-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceBoundary：授权根扩展", () => {
  it("① provider 返回授权根 ⇒ 根外绝对路径可解析", async () => {
    const primary = await createDirectory();
    const granted = await createDirectory();
    const boundary = new WorkspaceBoundary(primary, {
      additionalRootsProvider: async () => [granted],
    });
    const target = path.join(granted, "shared-note.txt");
    await writeFile(target, "ok", "utf8");
    await expect(boundary.resolveWithinWorkspace(target)).resolves.toBe(target);
  });

  it("② 未授权根 ⇒ 仍按逃逸拒绝；provider 抛错 ⇒ 只保留主根", async () => {
    const primary = await createDirectory();
    const other = await createDirectory();
    const boundary = new WorkspaceBoundary(primary, {
      additionalRootsProvider: async () => [other],
    });
    await expect(
      boundary.resolveWithinWorkspace(path.join(primary, "..", "outside.txt")),
    ).rejects.toThrow(/路径逃逸工作区被拒绝/);

    const failingBoundary = new WorkspaceBoundary(primary, {
      additionalRootsProvider: async () => {
        throw new Error("grant store unreadable");
      },
    });
    await expect(
      failingBoundary.resolveWithinWorkspace(path.join(other, "x.txt")),
    ).rejects.toThrow(/路径逃逸工作区被拒绝/);
  });

  it("③ 相对路径仍相对主根解析（授权根不改变相对语义）", async () => {
    const primary = await createDirectory();
    const granted = await createDirectory();
    const boundary = new WorkspaceBoundary(primary, {
      additionalRootsProvider: async () => [granted],
    });
    const resolved = await boundary.resolveWithinWorkspace("inside.txt");
    expect(resolved).toBe(path.join(primary, "inside.txt"));
  });
});
