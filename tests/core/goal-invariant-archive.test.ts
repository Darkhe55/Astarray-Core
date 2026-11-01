/**
 * R112（2026-11-01）：不变量违规归档轮转的单测。
 *
 * - 未超上限 ⇒ 不轮转；
 * - 超上限 ⇒ 原文件重命名为 `.1`、新文件为空、更旧文件按保留数删除。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  rotateInvariantViolationArchiveIfNeeded,
} from "../../packages/core/src/orchestration/goal-invariant-archive.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createArchive(lines: number): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-archive-"));
  directories.push(directory);
  const archivePath = path.join(directory, "archive.jsonl");
  const content = Array.from({ length: lines }, (_, index) =>
    JSON.stringify({ index }),
  ).join("\n");
  await writeFile(archivePath, content + "\n", "utf8");
  return archivePath;
}

describe("不变量违规归档轮转", () => {
  it("未超上限 ⇒ 不轮转", async () => {
    const archivePath = await createArchive(3);
    const rotated = await rotateInvariantViolationArchiveIfNeeded({
      archivePath,
      maximumLines: 5,
      retentionCount: 2,
    });
    expect(rotated).toBe(false);
    const content = await readFile(archivePath, "utf8");
    expect(content.split(/\r?\n/).filter((line) => line !== "")).toHaveLength(3);
  });

  it("超上限 ⇒ 原文件变 .1、新文件为空；旧 .1 顺移为 .2，超出保留数被删", async () => {
    const archivePath = await createArchive(6);
    await writeFile(`${archivePath}.1`, "older-1\n", "utf8");
    await writeFile(`${archivePath}.2`, "older-2\n", "utf8");
    const rotated = await rotateInvariantViolationArchiveIfNeeded({
      archivePath,
      maximumLines: 5,
      retentionCount: 2,
    });
    expect(rotated).toBe(true);
    expect((await readFile(archivePath, "utf8")).trim()).toBe("");
    const firstArchive = await readFile(`${archivePath}.1`, "utf8");
    expect(firstArchive.split(/\r?\n/).filter((line) => line !== "")).toHaveLength(6);
    const secondArchive = await readFile(`${archivePath}.2`, "utf8");
    expect(secondArchive.trim()).toBe("older-1");
    await expect(readFile(`${archivePath}.3`, "utf8")).rejects.toThrow();
  });
});
