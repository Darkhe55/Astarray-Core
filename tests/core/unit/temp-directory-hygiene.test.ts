/**
 * 测试临时目录卫生（此前不存在）：**开跑前清陈旧、跑完回收本次新建**。
 *
 * 这几条是它敢在测试主进程里删目录的前提：
 * 只碰指定前缀的目录、只删"基线之外"的与"超龄"的，其余一概不动；
 * 删不掉也不能让整轮测试变红。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTempDirectoryHygiene } from "../../global-setup/temp-directory-hygiene.js";

let baseDirectory: string;
const NOW = Date.now();
const STALE_AGE = 60_000;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hygiene-check-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function makeDirectory(
  name: string,
  ageMilliseconds = 0,
): Promise<string> {
  const directoryPath = path.join(baseDirectory, name);
  await fs.mkdir(directoryPath, { recursive: true });
  if (ageMilliseconds > 0) {
    const timestamp = new Date(NOW - ageMilliseconds);
    await fs.utimes(directoryPath, timestamp, timestamp);
  }
  return directoryPath;
}

function buildHygiene(prefixes: readonly string[] = ["astarray-"]) {
  return createTempDirectoryHygiene({
    baseDirectory,
    directoryNamePrefixes: prefixes,
    staleAgeMilliseconds: STALE_AGE,
    nowMilliseconds: () => NOW,
  });
}

describe("测试临时目录卫生", () => {
  it("① 开跑前删除超龄的陈旧目录，基线只含保留下来的", async () => {
    await makeDirectory("astarray-old-1", STALE_AGE * 2);
    await makeDirectory("astarray-fresh-1");
    const hygiene = buildHygiene();

    const result = await hygiene.beginRun();
    expect(result.removedStaleDirectoryCount).toBe(1);
    expect(result.baselineDirectoryCount).toBe(1);
    expect(await fs.readdir(baseDirectory)).toEqual(["astarray-fresh-1"]);
  });

  it("② 跑完回收本次新建的目录（即使用例没写 afterEach）", async () => {
    const hygiene = buildHygiene();
    await makeDirectory("astarray-baseline-1");
    await hygiene.beginRun();

    await makeDirectory("astarray-leaked-1");
    await makeDirectory("astarray-leaked-2");
    const result = await hygiene.endRun();

    expect(result.removedCreatedDirectoryCount).toBe(2);
    expect(result.remainingDirectoryCount).toBe(1);
    expect(await fs.readdir(baseDirectory)).toEqual(["astarray-baseline-1"]);
  });

  it("③ 不碰基线内目录，也不碰不匹配前缀的目录", async () => {
    await makeDirectory("astarray-baseline-2");
    await makeDirectory("other-tool-cache");
    const hygiene = buildHygiene();
    await hygiene.beginRun();

    /** 运行期间"别人"创建的不匹配目录同样不动。 */
    await makeDirectory("other-tool-cache-2");
    await makeDirectory("astarray-created");
    const result = await hygiene.endRun();

    expect(result.removedCreatedDirectoryCount).toBe(1);
    const remaining = (await fs.readdir(baseDirectory)).sort();
    expect(remaining).toEqual(["astarray-baseline-2", "other-tool-cache", "other-tool-cache-2"]);
  });

  it("④ 只处理目录：同前缀的文件不动", async () => {
    const filePath = path.join(baseDirectory, "astarray-not-a-directory.txt");
    await fs.writeFile(filePath, "x", "utf8");
    const hygiene = buildHygiene();
    await hygiene.beginRun();
    await hygiene.endRun();
    await expect(fs.stat(filePath)).resolves.toBeTruthy();
  });

  it("⑤ 目录不存在 ⇒ 不抛错（临时目录被系统清掉了也能跑）", async () => {
    const hygiene = createTempDirectoryHygiene({
      baseDirectory: path.join(baseDirectory, "missing-subdirectory"),
      directoryNamePrefixes: ["astarray-"],
      staleAgeMilliseconds: STALE_AGE,
      nowMilliseconds: () => NOW,
    });
    await expect(hygiene.beginRun()).resolves.toEqual({
      removedStaleDirectoryCount: 0,
      baselineDirectoryCount: 0,
    });
    await expect(hygiene.endRun()).resolves.toEqual({
      removedCreatedDirectoryCount: 0,
      remainingDirectoryCount: 0,
    });
  });

  it("⑥ 没调用 beginRun 直接 endRun ⇒ 也不误删（基线视为空但只删匹配前缀）", async () => {
    await makeDirectory("astarray-preexisting");
    const hygiene = buildHygiene();
    const result = await hygiene.endRun();
    expect(result.removedCreatedDirectoryCount).toBe(1);
    expect(result.remainingDirectoryCount).toBe(0);
  });
});
