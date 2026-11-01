/**
 * R118（2026-11-01）：轮转归档读取的单测。
 *
 * 从旧到新：.2 → .1 → 主文件；缺失文件跳过；空行忽略。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRotatedJsonlLines } from "../../packages/core/src/orchestration/rotated-jsonl-reader.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("轮转归档读取", () => {
  it("按 .2 → .1 → 主文件 顺序拼接，并忽略空行", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-rotated-"));
    directories.push(directory);
    const archivePath = path.join(directory, "archive.jsonl");
    await writeFile(`${archivePath}.2`, '{"i":0}\n\n', "utf8");
    await writeFile(`${archivePath}.1`, '{"i":1}\n', "utf8");
    await writeFile(archivePath, '{"i":2}\n', "utf8");
    const result = await readRotatedJsonlLines({ archivePath });
    expect(result.lines).toEqual(['{"i":0}', '{"i":1}', '{"i":2}']);
    expect(result.filesRead).toHaveLength(3);
  });

  it("缺失文件跳过（只有主文件也能读）", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-rotated-"));
    directories.push(directory);
    const archivePath = path.join(directory, "archive.jsonl");
    await writeFile(archivePath, '{"i":9}\n', "utf8");
    const result = await readRotatedJsonlLines({ archivePath, rotationCount: 2 });
    expect(result.lines).toEqual(['{"i":9}']);
    expect(result.filesRead).toEqual([archivePath]);
  });
});
