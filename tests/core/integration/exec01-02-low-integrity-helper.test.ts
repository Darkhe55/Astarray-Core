/**
 * E1 弱档（2026-11-25）：Windows 受限令牌 + Low 完整性级别的反例优先验证。
 *
 * 产物语义（必须如实标注）：
 * - **写入**：对中等完整性对象（用户目录、仓库）被拒（no-write-up）；
 * - **读取**：**不被拦截**——本文件用反例证明"读不设防"，产品文案不得宣称读隔离；
 * - 不需要提权、不依赖 AppContainer 档案。
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const helperPath = path.join(process.cwd(), "native", "sandbox-helper", "sandbox-helper.exe");
const isAcceptanceHost = process.platform === "win32" && existsSync(helperPath);

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lowil-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function runHelper(argumentsList: readonly string[]) {
  const result = spawnSync(helperPath, [...argumentsList], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function helperArguments(commandLine: string): string[] {
  return [
    "run",
    "--profile",
    "astarray-exec",
    "--low-integrity",
    "--timeout-ms",
    "20000",
    "--work-dir",
    workingDirectory,
    "--max-memory-mb",
    "256",
    "--max-processes",
    "8",
    "--",
    "C:\\Windows\\System32\\cmd.exe",
    "/c",
    commandLine,
  ];
}

describe.skipIf(!isAcceptanceHost)("E1 弱档：Low IL 受限令牌", () => {
  it("① 能启动并回传输出（不需要提权/档案）", () => {
    const result = runHelper(helperArguments("echo low-ok"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("job-assigned");
    expect(result.stdout).toContain("low-ok");
    expect(result.stdout).toContain("exit-code 0");
  });

  it("② 写入用户主目录被拒（no-write-up，确定性的中等完整性目标）", async () => {
    /**
     * 用 `%USERPROFILE%`（登录时创建、中完整性）作为目标，避免依赖"测试进程自身完整性"
     * ——若测试运行在低完整性沙箱里，临时目录也会是低完整性，写测试会失去意义。
     */
    const result = runHelper(helperArguments("echo x > %USERPROFILE%\\astarray-lowil-write.txt"));
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Access is denied|拒绝访问/u);
    const targetPath = path.join(os.homedir(), "astarray-lowil-write.txt");
    await expect(fs.access(targetPath)).rejects.toThrow();
  });

  it("②b 令牌完整性级别确实是 Low（S-1-16-4096）", () => {
    const result = runHelper(helperArguments("whoami /groups"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("S-1-16-4096");
  });
  it("③ 读取**不被拦截**（如实证明：弱档不是读隔离，不得宣称）", async () => {
    const visiblePath = path.join(workingDirectory, "readable.txt");
    await fs.writeFile(visiblePath, "weak-tier-can-read", "utf8");
    /** 用 type 读一个中等完整性文件；若"被拦"说明我们错误宣称了更弱的语义。 */
    const result = runHelper(helperArguments("type readable.txt"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("weak-tier-can-read");
  });
});
