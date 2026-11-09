/**
 * SEC-02 通道 14（2026-11-09）：**诊断输出不得绕过唯一漏斗**。
 *
 * 静态守卫：`packages/tui/src/cli/**` 里除漏斗自身外，不得出现裸 `process.stderr.write(`。
 * 否则新增的报错路径会绕开脱敏与换行转义（这正是本轮迁移前的状态：18 处绕过）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const CLI_DIRECTORY_PATH = path.join(process.cwd(), "packages", "tui", "src", "cli");
const FUNNEL_FILE_NAME = "json-output.ts";

async function listSourceFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("SEC-02 CLI 诊断输出静态守卫", () => {
  it("除漏斗外不得直接写 stderr", async () => {
    const sourceFiles = await listSourceFiles(CLI_DIRECTORY_PATH);
    const offendingFiles: string[] = [];
    for (const filePath of sourceFiles) {
      if (path.basename(filePath) === FUNNEL_FILE_NAME) continue;
      const content = await fs.readFile(filePath, "utf8");
      /** 只看**代码**里的调用；注释中的提及不算违规。 */
      const codeLines = content
        .split(/\r?\n/u)
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
      if (codeLines.some((line) => line.includes("process.stderr.write("))) {
        offendingFiles.push(path.relative(process.cwd(), filePath));
      }
    }
    expect(offendingFiles).toEqual([]);
  }, 30_000);

  it("漏斗自身仍在（防止守卫因文件改名而空转）", async () => {
    const funnelPath = path.join(CLI_DIRECTORY_PATH, FUNNEL_FILE_NAME);
    const content = await fs.readFile(funnelPath, "utf8");
    expect(content).toContain("export function writeDiagnosticText");
    expect(content).toContain("redactSensitiveText");
    expect(content).toContain("sanitizeLogLine");
  }, 30_000);
});
