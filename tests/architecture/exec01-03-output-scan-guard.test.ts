/**
 * EXEC-01-03 通道守卫：**未扫描的原始输出不得进入日志或历史**（2026-11-14）。
 *
 * 卡内 §03 原文：「未扫描原始输出不进入普通日志或模型历史」。
 *
 * 核实结论（2026-11-14）：`packages/core/src/execution/**` 目前**没有**任何往日志/历史写输出的代码，
 * 因此当前不存在泄漏；但当时**没有静态守卫**阻止以后有人图省事把 `chunk.text` 直接写进日志——
 * 那种改动不会有测试红，只会悄悄泄漏。本文件补的就是这条守卫。
 *
 * 规则（两条，都是"代码里出现即失败"，注释里提到不算）：
 *  1. `readAllTextForScanning()` 只允许在**扫描门禁自身**里调用（该函数返回全量未脱敏文本，
 *     一旦被日志/历史路径拿去用就是直接泄漏）；
 *  2. `execution/**` 内不得出现日志/历史写入调用（`writeDiagnosticText` / `logToStderr` /
 *     `console.log` / `console.error` / `console.warn`）——执行模块的输出只能经
 *     `readOutput`（已带跨块敏感扫描）交出去。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const EXECUTION_DIRECTORY_PATH = path.join(process.cwd(), "packages", "core", "src", "execution");
const SCAN_GATE_FILE_NAMES = new Set([
  "sensitive-output-scan-gate.ts",
  "process-execution-output-buffer.ts",
]);
const FORBIDDEN_LOG_CALL_PATTERN =
  /\b(writeDiagnosticText|logToStderr|console\.(log|error|warn|info|debug))\s*\(/u;

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

/** 只看**代码**行：注释里提到这些名字不算违规。 */
function readCodeLines(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
}

describe("EXEC-01-03 未扫描输出守卫", () => {
  it("① 只有扫描门禁自身可以调用 readAllTextForScanning()", async () => {
    const sourceFiles = await listSourceFiles(EXECUTION_DIRECTORY_PATH);
    const offendingFiles: string[] = [];
    for (const filePath of sourceFiles) {
      if (SCAN_GATE_FILE_NAMES.has(path.basename(filePath))) {
        continue;
      }
      const codeLines = readCodeLines(await fs.readFile(filePath, "utf8"));
      if (codeLines.some((line) => line.includes("readAllTextForScanning("))) {
        offendingFiles.push(path.relative(process.cwd(), filePath));
      }
    }
    expect(offendingFiles).toEqual([]);
  }, 30_000);

  it("② execution 目录内不得直接写日志或历史（输出只能经 readOutput 交出去）", async () => {
    const sourceFiles = await listSourceFiles(EXECUTION_DIRECTORY_PATH);
    const offendingFiles: string[] = [];
    for (const filePath of sourceFiles) {
      const codeLines = readCodeLines(await fs.readFile(filePath, "utf8"));
      if (codeLines.some((line) => FORBIDDEN_LOG_CALL_PATTERN.test(line))) {
        offendingFiles.push(path.relative(process.cwd(), filePath));
      }
    }
    expect(offendingFiles).toEqual([]);
  }, 30_000);

  it("③ 守卫自身有效：对已知违规样本必须报红（防止守卫空转）", () => {
    /** 用与守卫相同的判定逻辑跑一段"故意违规"的样本。 */
    const violatingSample = [
      'const text = buffer.readAllTextForScanning();',
      "console.log(text);",
      'logToStderr("raw output: " + chunk.text);',
    ];
    const caughtByRuleOne = violatingSample.some((line) =>
      line.includes("readAllTextForScanning("),
    );
    const caughtByRuleTwo = violatingSample.some((line) =>
      FORBIDDEN_LOG_CALL_PATTERN.test(line),
    );
    expect(caughtByRuleOne).toBe(true);
    expect(caughtByRuleTwo).toBe(true);
    /** 注释行不得被判违规（否则守卫会因为文档提及而误报）。 */
    const commentLine = " * 注意：不得调用 readAllTextForScanning() 或 console.log(raw)";
    expect(readCodeLines(commentLine)).toEqual([]);
  });
});
