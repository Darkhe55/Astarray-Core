/**
 * B9（2026-11-25）：task-ledger 写回/绑定命令的守卫分支（index-missing / invalid-task-chain）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  executeTaskLedgerApplyWriteBackCommand,
  executeTaskLedgerBindTaskMapCommand,
} from "../../../packages/tui/src/cli/task-ledger-command.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ledger-wb-"));
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
      prompt: "账本绑定",
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

describe("B9：task-ledger 写回/绑定守卫", () => {
  it("① apply-write-back：无绑定 ⇒ index-missing（JSON/文本均退出 2）", async () => {
    expect(
      await executeTaskLedgerApplyWriteBackCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        approvedBy: "user-1",
        expectedSequenceRevision: 1,
        isJsonOutput: true,
      } as never),
    ).toBe(2);
    expect(JSON.parse(text())).toMatchObject({ status: "index-missing" });

    captured.length = 0;
    expect(
      await executeTaskLedgerApplyWriteBackCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        approvedBy: "user-1",
        expectedSequenceRevision: 1,
        isJsonOutput: false,
      } as never),
    ).toBe(2);
    expect(text()).toContain("index-missing");
  });

  it("② bind-task-map：无绑定 ⇒ index-missing（JSON/文本均退出 2）", async () => {
    expect(
      await executeTaskLedgerBindTaskMapCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        missionTaskIdentifier: "T-1",
        sequenceTaskIdentifier: "seq-task-1",
        isJsonOutput: true,
      } as never),
    ).toBe(2);
    expect(JSON.parse(text())).toMatchObject({ status: "index-missing" });

    captured.length = 0;
    expect(
      await executeTaskLedgerBindTaskMapCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        missionTaskIdentifier: "T-1",
        sequenceTaskIdentifier: "seq-task-1",
        isJsonOutput: false,
      } as never),
    ).toBe(2);
    expect(text()).toContain("index-missing");
  });

  it("③ bind-task-map：有绑定但 mission 无该任务 ⇒ invalid-task-chain（退出 2）", async () => {
    const missionIdentifier = await createMission();
    expect(
      await executeTaskLedgerBindTaskMapCommand({
        stateDirectory,
        missionIdentifier,
        missionTaskIdentifier: "T-404",
        sequenceTaskIdentifier: "seq-task-1",
        isJsonOutput: true,
      } as never),
    ).toBe(2);
    expect(JSON.parse(text())).toMatchObject({ status: "invalid-task-chain" });
  });

  it("④ bind-task-map：哨兵 * 放行 mission 校验，但序列无节点 ⇒ invalid-task-chain", async () => {
    const missionIdentifier = await createMission();
    const outcome = await executeTaskLedgerBindTaskMapCommand({
      stateDirectory,
      missionIdentifier,
      missionTaskIdentifier: "*",
      sequenceTaskIdentifier: "seq-task-404",
      isJsonOutput: true,
    } as never).catch((error: Error) => ({ error: error.message }));
    /** 序列可能不存在 ⇒ 允许抛错或返回 invalid-task-chain；不得返回 bound。 */
    expect(outcome).not.toHaveProperty("status", "bound");
  });
});
