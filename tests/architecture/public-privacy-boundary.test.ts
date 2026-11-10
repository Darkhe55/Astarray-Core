/**
 * 公开仓库隐私边界（2026-11-10）：**公开内容不得描述外部 UI 仓库的存在或结构**。
 *
 * 规则来源：`AGENTS.md` §0「公开仓库不得出现私有仓库的任何信息：仓库名、
 * 绝对/相对路径、目录结构、包名、测试路径、'存在私有库'的描述」。
 *
 * 2026-11-10 已改写历史（1903 个提交）清除了既有泄漏，本守卫负责**阻止新增**：
 * 任何被跟踪文件（文档与源码）出现下列措辞即失败。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const runGit = promisify(execFile);

/** 会暴露外部 UI 仓库存在/结构的措辞（含仓库名与路径片段）。 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "外部仓库名", pattern: /astarray-ui/u },
  { label: "外部 UI 包目录", pattern: /私有\s*GUI\s*包/u },
  { label: "外部 TUI 包目录", pattern: /私有\s*TUI\s*包/u },
  { label: "外部 UI 测试目录", pattern: /私有\s*GUI\s*测试/u },
  /** 只匹配**真实用户名**：`C:\Users\<username>` 与 `C:\Users\...` 是刻意匿名，不算泄漏。 */
  { label: "本机用户目录", pattern: /C:\\Users\\[A-Za-z0-9\u4e00-\u9fff]/u },
];

/** 本守卫自身必然包含上述词（用于检测），扫描时排除。 */
const SELF_PATH = "tests/architecture/public-privacy-boundary.test.ts";

async function listTrackedFiles(): Promise<string[]> {
  const { stdout } = await runGit("git", ["ls-files"], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== SELF_PATH);
}

describe("公开内容隐私边界", () => {
  it("被跟踪文件不得出现外部 UI 仓库的存在或结构描述", async () => {
    const trackedFiles = await listTrackedFiles();
    const offendingFiles: string[] = [];
    for (const relativePath of trackedFiles) {
      /** 二进制与超大文件跳过：它们不是措辞泄漏的载体。 */
      if (/\.(png|jpg|jpeg|gif|webp|ico|zip|tgz|bundle)$/iu.test(relativePath)) continue;
      const filePath = path.join(process.cwd(), relativePath);
      const content = await fs.readFile(filePath, "utf8").catch(() => "");
      if (FORBIDDEN_PATTERNS.some((entry) => entry.pattern.test(content))) {
        offendingFiles.push(relativePath);
      }
    }
    expect(offendingFiles).toEqual([]);
  }, 60_000);
});
