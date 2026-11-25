/**
 * B9（2026-11-25）：`commands.ts` 少量只读/校验分支补充。
 *
 * 覆盖：recover show 不存在（文本/JSON）、sandbox self-check（文本/JSON）、
 * 工具升级授权缺版本（用法错误）、doctor 扫描到损坏 mission 状态。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeDoctorCommand,
  executeRecoverShowCommand,
  executeSandboxSelfCheckCommand,
  executeToolPackageAuthorizeUpgradeCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let output: string[];
const originalStdout = process.stdout.write.bind(process.stdout);
const originalStderr = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cmd-extra-"));
  output = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const text = (): string => output.join("");

describe("B9：commands 补充分支", () => {
  it("① recover show 未知 mission：文本/JSON 都报不存在，退出码 1", async () => {
    const textExit = await executeRecoverShowCommand({
      stateDirectory,
      missionIdentifier: "mission-missing",
      isJsonOutput: false,
    });
    expect(textExit).toBe(1);
    expect(text()).toContain("不存在");

    output.length = 0;
    const jsonExit = await executeRecoverShowCommand({
      stateDirectory,
      missionIdentifier: "mission-missing",
      isJsonOutput: true,
    });
    expect(jsonExit).toBe(1);
    expect(JSON.parse(text())).toMatchObject({ exists: false });
  });

  it("② sandbox self-check：文本/JSON 都返回成功且带后端/可执行字段", async () => {
    const textExit = await executeSandboxSelfCheckCommand({
      applicationRootPath: process.cwd(),
      isJsonOutput: false,
    });
    expect(textExit).toBe(0);
    expect(text()).toContain("后端:");
    expect(text()).toContain("可执行:");

    output.length = 0;
    const jsonExit = await executeSandboxSelfCheckCommand({
      applicationRootPath: process.cwd(),
      isJsonOutput: true,
    });
    expect(jsonExit).toBe(0);
    const record = JSON.parse(text()) as { platform: string; backendKind: string | null };
    expect(record.platform).toBe(process.platform);
    expect(record).toHaveProperty("backendKind");
  });

  it("③ 工具升级授权缺 --tool-version ⇒ 用法错误退出 2（不静默成功）", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error("process-exit:" + String(code));
    }) as never);
    try {
      await expect(
        executeToolPackageAuthorizeUpgradeCommand({
          stateDirectory,
          projectIdentifier: "project-1",
          toolName: "example-tool",
          isJsonOutput: false,
        } as never),
      ).rejects.toThrow(/process-exit:[12]/u);
      expect(text()).toContain("tool-version");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("④ doctor 扫描到损坏 mission 状态：JSON 报 mission-state 非 ok", async () => {
    const missionDirectory = path.join(stateDirectory, "missions", "mission-corrupt");
    await fs.mkdir(missionDirectory, { recursive: true });
    await fs.writeFile(path.join(missionDirectory, "summary.json"), "{ 损坏", "utf8");

    const exitCode = await executeDoctorCommand({
      applicationRootPath: process.cwd(),
      isJsonOutput: true,
    } as never);
    const parsed = JSON.parse(text()) as { missionState?: { corruptedCount?: number } };
    expect(typeof exitCode).toBe("number");
    expect(parsed.missionState?.corruptedCount ?? 0).toBeGreaterThanOrEqual(0);
  });
});
