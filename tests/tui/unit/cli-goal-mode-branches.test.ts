/**
 * B9（2026-11-24）：`goal-mode` 只读入口分支（status / verdicts）。
 *
 * 覆盖：未知目标（exit 2）、空状态只读汇总（文本/JSON）、判定记录空视图、
 * 导出空路径拒绝、导出到文件成功。
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

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-goal-cli-"));
});

afterEach(async () => {
  process.exitCode = undefined;
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function silenceStderr(): () => void {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
}

async function run(action: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

describe("B9：goal-mode status", () => {
  it("① 未知目标（文本/JSON）⇒ goal-not-found，退出码 2", async () => {
    const text = await run(() =>
      executeGoalModeStatusCommand({ stateDirectory, goalIdentifier: "goal-missing", isJsonOutput: false }),
    );
    expect(text.exitCode).toBe(2);
    expect(text.output).toContain("没有目标 goal-missing 的状态");

    const json = await run(() =>
      executeGoalModeStatusCommand({ stateDirectory, goalIdentifier: "goal-missing", isJsonOutput: true }),
    );
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.output)).toMatchObject({ status: "goal-not-found" });
  });

  it("② 空状态：JSON 只读汇总（0 契约/0 绑定）", async () => {
    const { exitCode, output } = await run(() =>
      executeGoalModeStatusCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as {
      status: string;
      contractCount: number;
      bindingCount: number;
      restoredGateCount: number;
      notes: string[];
    };
    expect(parsed).toMatchObject({
      status: "read-only",
      contractCount: 0,
      bindingCount: 0,
      restoredGateCount: 0,
    });
    expect(parsed.notes.join("")).toContain("只读");
  });

  it("③ 空状态：文本只读汇总", async () => {
    const { exitCode, output } = await run(() =>
      executeGoalModeStatusCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(exitCode).toBe(0);
    expect(output).toContain("目标模式状态（只读）");
  });
});

describe("B9：goal-mode verdicts", () => {
  it("④ 空判定记录：JSON 只读；文本明确「还没有任何判定记录」", async () => {
    const json = await run(() =>
      executeGoalModeVerdictsCommand({
        stateDirectory,
        recentCount: 10,
        isJsonOutput: true,
      }),
    );
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({
      status: "read-only",
      returnedCount: 0,
      records: [],
    });

    const text = await run(() =>
      executeGoalModeVerdictsCommand({
        stateDirectory,
        recentCount: 10,
        isJsonOutput: false,
      }),
    );
    expect(text.output).toContain("还没有任何判定记录");
  });

  it("⑤ 导出空路径 ⇒ 拒绝（exit 2）", async () => {
    const restoreStderr = silenceStderr();
    let exitCode: number;
    try {
      exitCode = await executeGoalModeVerdictsCommand({
        stateDirectory,
        recentCount: 10,
        isJsonOutput: true,
        exportPath: "   ",
      });
    } finally {
      restoreStderr();
    }
    expect(exitCode!).toBe(2);
  });

  it("⑥ 导出到文件 ⇒ exported（0 条也写空文件）", async () => {
    const exportPath = path.join(stateDirectory, "verdicts.jsonl");
    const { exitCode, output } = await run(() =>
      executeGoalModeVerdictsCommand({
        stateDirectory,
        recentCount: 10,
        isJsonOutput: true,
        exportPath,
      }),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ status: "exported", exportedCount: 0 });
    await expect(fs.access(exportPath)).resolves.toBeUndefined();
  });
});
