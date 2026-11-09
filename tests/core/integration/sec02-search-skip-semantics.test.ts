/**
 * SEC-02 通道 3（2026-11-09）：**跳过 ≠ 未找到**。
 *
 * 真实缺陷：本地检索对"文件过大 / 不可读 / 二进制"三种情况直接 `continue`
 * 且不计数 ⇒ 一个只有二进制文件的目录会返回"（未找到匹配）"，
 * 把**未完成**当成**确定没有**（卡内明确禁止的口径）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchProjectText } from "../../../packages/core/src/tools/builtins.js";

vi.setConfig({ testTimeout: 30_000 });

let workspaceRootPath: string;

beforeEach(async () => {
  workspaceRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-search-skip-"));
});

afterEach(async () => {
  await fs.rm(workspaceRootPath, { recursive: true, force: true, maxRetries: 10 });
});

/** 放行的本地策略引擎替身：本文件只验证"跳过口径"，不验证路径策略。 */
const permissiveLocalEngine = {
  assertPonderReadonlyFilePath: async (candidatePath: string) => candidatePath,
} as never;

async function runSearch(query: string): Promise<string> {
  return await searchProjectText(workspaceRootPath, query, permissiveLocalEngine, null);
}

describe("SEC-02 本地检索的完整性口径", () => {
  it("只有二进制文件 ⇒ 报**未完成**，不得报未找到", async () => {
    await fs.writeFile(
      path.join(workspaceRootPath, "blob.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    );
    const outputText = await runSearch("目标关键词");
    expect(outputText).toContain("未完成");
    expect(outputText).not.toContain("未找到匹配");
  }, 30_000);

  it("超大文件 ⇒ 同样报未完成", async () => {
    /** 超过 512 KiB 阈值。 */
    await fs.writeFile(path.join(workspaceRootPath, "huge.txt"), "a".repeat(600 * 1024));
    const outputText = await runSearch("目标关键词");
    expect(outputText).toContain("未完成");
  }, 30_000);

  it("真空目录 ⇒ 报未找到（确实没有可检索内容）", async () => {
    const outputText = await runSearch("目标关键词");
    expect(outputText).toContain("未找到匹配");
    expect(outputText).not.toContain("未完成");
  }, 30_000);

  it("有命中且有跳过 ⇒ 给出结果并**明确标注可能不完整**", async () => {
    await fs.writeFile(path.join(workspaceRootPath, "hit.txt"), "这里包含目标关键词\n");
    await fs.writeFile(path.join(workspaceRootPath, "blob.bin"), Buffer.from([0x00, 0x01]));
    const outputText = await runSearch("目标关键词");
    expect(outputText).toContain("目标关键词");
    expect(outputText).toContain("可能不完整");
  }, 30_000);
});
