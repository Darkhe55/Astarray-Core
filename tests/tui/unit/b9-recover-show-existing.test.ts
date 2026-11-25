/**
 * B9（2026-11-25）：recover show / recover list 的**存在 mission**分支（文本 + JSON）。
 *
 * 此前只覆盖了"mission 不存在"的两条路径；本文件补存在分支与列表分支。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  executeRecoverListCommand,
  executeRecoverShowCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-recover-show-"));
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

async function createMission(): Promise<string> {
  const facade = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
  });
  try {
    facade.createSession({ sessionId: "session-1", mode: "assist" });
    const submitted = await facade.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "恢复查看",
    } as never);
    const missionIdentifier = (submitted as { missionIdentifier: string }).missionIdentifier;
    const deadline = Date.now() + 30_000;
    let status = "accepted";
    while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await facade.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })).status;
    }
    return missionIdentifier;
  } finally {
    await facade.shutdown().catch(() => undefined);
  }
}

describe("B9：recover show / list 存在分支", () => {
  it("① recover show：存在的 mission ⇒ 文本输出含状态、退出 0", async () => {
    const missionIdentifier = await createMission();
    const exitCode = await executeRecoverShowCommand({
      stateDirectory,
      missionIdentifier,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(text()).toContain(missionIdentifier);
    expect(text()).toContain("状态");
  });

  it("② recover show：存在的 mission ⇒ JSON 输出可解析且标识一致", async () => {
    const missionIdentifier = await createMission();
    const exitCode = await executeRecoverShowCommand({
      stateDirectory,
      missionIdentifier,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const view = JSON.parse(text()) as { missionIdentifier: string; exists?: boolean };
    expect(view.missionIdentifier).toBe(missionIdentifier);
  });

  it("③ recover list：有 mission 时文本/JSON 都返回列表", async () => {
    await createMission();
    expect(await executeRecoverListCommand({ stateDirectory, isJsonOutput: false } as never)).toBe(
      0,
    );
    expect(text()).toContain("mission");
    captured.length = 0;
    expect(await executeRecoverListCommand({ stateDirectory, isJsonOutput: true } as never)).toBe(0);
    const parsed = JSON.parse(text()) as unknown;
    expect(typeof parsed).toBe("object");
  });
});
