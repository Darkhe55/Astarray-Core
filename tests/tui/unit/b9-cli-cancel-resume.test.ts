/**
 * B9（2026-11-25）：CLI 取消/续接命令的**成功与已完成**分支（文本 + JSON）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  executeCancelCommand,
  executeResumeCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-cancel-"));
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

async function createCompletedMission(prompt: string): Promise<string> {
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
      prompt,
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

describe("B9：CLI 取消/续接分支", () => {
  it("① 取消：存在的 mission ⇒ 文本/JSON 都成功且不抛错", async () => {
    const missionIdentifier = await createCompletedMission("取消文本");
    expect(
      await executeCancelCommand({ stateDirectory, missionId: missionIdentifier, isJsonOutput: false }),
    ).toBe(0);
    expect(text()).toContain("cancelled:");

    captured.length = 0;
    expect(
      await executeCancelCommand({ stateDirectory, missionId: missionIdentifier, isJsonOutput: true }),
    ).toBe(0);
    expect(JSON.parse(text())).toMatchObject({ status: "cancelled" });
  });

  it("② 续接：已完成的 mission ⇒ already-complete（文本/JSON），不再派发", async () => {
    const missionIdentifier = await createCompletedMission("已完成");
    expect(
      await executeResumeCommand({ stateDirectory, missionId: missionIdentifier, isJsonOutput: false }),
    ).toBe(0);
    expect(text()).toContain("already-complete:");

    captured.length = 0;
    expect(
      await executeResumeCommand({ stateDirectory, missionId: missionIdentifier, isJsonOutput: true }),
    ).toBe(0);
    expect(JSON.parse(text())).toMatchObject({ resumed: false, status: "done" });
  });
});
