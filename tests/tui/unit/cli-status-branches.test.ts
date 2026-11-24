/**
 * B9（2026-11-24）：`status` / `resume` 命令分支（真实临时状态目录 + mock 运行时）。
 *
 * 覆盖：列表模式（文本/JSON）、单 mission 模式（文本/JSON）、
 * resume 的 already-complete 早返回，以及"未知 mission"的失败路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";
import {
  executeResumeCommand,
  executeStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-status-"));
});

afterEach(async () => {
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

async function createFinishedMission(): Promise<string> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 4,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
    workerRuntimeFactory: () =>
      new ScriptedRuntime([
        { type: "text", text: "完成" },
        { type: "finish", reason: "success", detail: "ok" },
      ]),
  });
  try {
    const missionId = await runtime.controller.handleUserMessage("做一个测试任务");
    const deadline = Date.now() + 30_000;
    let status = await runtime.controller.queryMissionStatus(missionId);
    while (status?.summary?.status !== "done" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await runtime.controller.queryMissionStatus(missionId);
    }
    return missionId;
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("B9：status/resume 命令分支", () => {
  it("① status（无 mission，文本）⇒ 空列表 + 成功", async () => {
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await executeStatusCommand({
        missionId: undefined,
        isJsonOutput: false,
        stateDirectory,
      });
    } finally {
      capture.restore();
    }
    expect(exitCode).toBe(0);
    expect(capture.text()).toBe("\n");
  });

  it("② status（无 mission，JSON）⇒ 数组", async () => {
    const capture = captureStdout();
    try {
      await executeStatusCommand({
        missionId: undefined,
        isJsonOutput: true,
        stateDirectory,
      });
    } finally {
      capture.restore();
    }
    const parsed = JSON.parse(capture.text()) as { missions: unknown[]; missionViews: unknown[] };
    expect(parsed.missions).toEqual([]);
    expect(parsed.missionViews).toEqual([]);
  });

  it("③ status（已有 mission，JSON）⇒ 返回 summary 与任务链", async () => {
    const missionId = await createFinishedMission();
    const capture = captureStdout();
    try {
      await executeStatusCommand({ missionId, isJsonOutput: true, stateDirectory });
    } finally {
      capture.restore();
    }
    const parsed = JSON.parse(capture.text()) as { missionId: string; status?: string; tasks: unknown[] };
    expect(parsed.missionId).toBe(missionId);
    expect(parsed.status).toBe("done");
    expect(Array.isArray(parsed.tasks)).toBe(true);
  });

  it("④ status（已有 mission，文本）⇒ 打印 mode/status/tasks", async () => {
    const missionId = await createFinishedMission();
    const capture = captureStdout();
    try {
      await executeStatusCommand({ missionId, isJsonOutput: false, stateDirectory });
    } finally {
      capture.restore();
    }
    const text = capture.text();
    expect(text).toContain("mission: ");
    expect(text).toContain("status: ");
    expect(text).toContain("tasks: ");
  });

  it("⑤ resume 已完成 mission（文本）⇒ already-complete 早返回", async () => {
    const missionId = await createFinishedMission();
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await executeResumeCommand({ missionId, isJsonOutput: false, stateDirectory });
    } finally {
      capture.restore();
    }
    expect(exitCode).toBe(0);
    expect(capture.text()).toContain("already-complete");
  });

  it("⑥ status（未知 mission，JSON）⇒ 用法错误退出（exit 2），不伪造状态", async () => {
    const originalError = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { exitCode: code });
    }) as never);
    try {
      await expect(
        executeStatusCommand({
          missionId: "mission-missing",
          isJsonOutput: true,
          stateDirectory,
        }),
      ).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      exitSpy.mockRestore();
      process.stderr.write = originalError;
    }
  });
});
