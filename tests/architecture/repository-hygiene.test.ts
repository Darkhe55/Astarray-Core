/**
 * 活规则：仓库卫生（2026-10-20 R97）。
 *
 * 背景：R90 我差点在**陈旧 tarball** 上跑出"假绿"；R96 做隐私扫描时确认
 * `astarray-0.1.0.tgz` 未被跟踪、`.astarray/` 与 `.tmp/` 未入库。
 *
 * 这几条一旦从 `.gitignore` 里被删掉，下一次 `git add -A`（或他人的粗心提交）
 * 就可能把**构建产物、本地状态库、临时脚本**带进公开仓库 —— 其中 `.astarray/` 还含本机运行痕迹。
 * 所以把它变成可执行的守卫，而不是靠人记得。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "..", "..");

async function readGitignoreLines(): Promise<string[]> {
  const gitignoreText = await fs.readFile(path.join(repositoryRoot, ".gitignore"), "utf8");
  return gitignoreText.split(/\r?\n/).map((line) => line.trim());
}

describe("仓库卫生（.gitignore 守卫）", () => {
  it("① 本地状态库与临时目录不得入库（含本机运行痕迹）", async () => {
    const lines = await readGitignoreLines();
    expect(lines).toContain(".astarray/");
    expect(lines).toContain(".tmp/");
  });

  it("② 构建产物与打包产物不得入库", async () => {
    const lines = await readGitignoreLines();
    expect(lines).toContain("dist/");
    expect(lines).toContain("*.tgz");
  });

  it("③ 凭据文件类型不得入库（与 AGENTS.md 的隐私自检对齐）", async () => {
    const lines = await readGitignoreLines();
    for (const requiredPattern of [".env", "*.pem", "*.key"]) {
      const isCovered = lines.some((line) => line.startsWith(requiredPattern));
      expect(isCovered, `缺少忽略规则：${requiredPattern}`).toBe(true);
    }
  });
});
