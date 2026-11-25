/**
 * B9（2026-11-25）：goal-mode status/verdicts 与 run 的入口校验分支。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeGoalModeStatusCommand,
  executeGoalModeVerdictsCommand,
} from "../../../packages/tui/src/cli/goal-mode-command.js";
import { executeRunCommand } from "../../../packages/tui/src/cli/run-command.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-goal-cli-"));
  captured = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const text = (): string => captured.join("");

async function withExitSpy<T>(action: () => Promise<T>): Promise<unknown> {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error("process-exit:" + String(code));
  }) as never);
  try {
    return await action().catch((error: Error) => ({ rejected: error.message }));
  } finally {
    exitSpy.mockRestore();
  }
}

describe("B9：goal-mode 与 run 入口校验", () => {
  it("① goal-mode status：空状态文本/JSON 都退出 0", async () => {
    expect(
      await executeGoalModeStatusCommand({ stateDirectory, isJsonOutput: false }),
    ).toBe(0);
    expect(text()).toContain("目标模式");
    captured.length = 0;
    expect(await executeGoalModeStatusCommand({ stateDirectory, isJsonOutput: true })).toBe(0);
    expect(JSON.parse(text())).toMatchObject({ status: "read-only" });
  });

  it("② goal-mode status --goal 未知：文本/JSON 都退出 2", async () => {
    expect(
      await executeGoalModeStatusCommand({
        stateDirectory,
        isJsonOutput: false,
        goalIdentifier: "goal-missing",
      }),
    ).toBe(2);
    expect(text()).toContain("没有目标");
    captured.length = 0;
    expect(
      await executeGoalModeStatusCommand({
        stateDirectory,
        isJsonOutput: true,
        goalIdentifier: "goal-missing",
      }),
    ).toBe(2);
    expect(JSON.parse(text())).toMatchObject({ status: "goal-not-found" });
  });

  it("③ goal-mode verdicts：空记录文本/JSON；导出成功与非空路径校验", async () => {
    expect(
      await executeGoalModeVerdictsCommand({ stateDirectory, isJsonOutput: false, recentCount: 5 }),
    ).toBe(0);
    expect(text()).toContain("判定记录");
    captured.length = 0;
    expect(
      await executeGoalModeVerdictsCommand({ stateDirectory, isJsonOutput: true, recentCount: 5 }),
    ).toBe(0);
    expect(JSON.parse(text())).toMatchObject({ status: "read-only" });

    captured.length = 0;
    const exportPath = path.join(stateDirectory, "verdicts.jsonl");
    expect(
      await executeGoalModeVerdictsCommand({
        stateDirectory,
        isJsonOutput: true,
        recentCount: 5,
        exportPath,
      }),
    ).toBe(0);
    expect(JSON.parse(text())).toMatchObject({ status: "exported" });
    expect(await fs.readFile(exportPath, "utf8")).toContain("");

    captured.length = 0;
    expect(
      await executeGoalModeVerdictsCommand({
        stateDirectory,
        isJsonOutput: false,
        recentCount: 5,
        exportPath: "   ",
      }),
    ).toBe(2);
    expect(text()).toContain("--export");
  });

  it("④ run：非法配置与缺少 --json 都以用法错误退出（不静默运行）", async () => {
    const invalidConfig = await withExitSpy(() =>
      executeRunCommand({
        stateDirectory,
        mode: "unknown-mode",
        runtime: "mock",
        isJsonOutput: true,
      } as never),
    );
    expect(invalidConfig).toMatchObject({ rejected: "process-exit:2" });

    const missingJson = await withExitSpy(() =>
      executeRunCommand({
        stateDirectory,
        mode: "assist",
        runtime: "mock",
        isJsonOutput: false,
      } as never),
    );
    expect(missingJson).toMatchObject({ rejected: "process-exit:2" });
  });
});
