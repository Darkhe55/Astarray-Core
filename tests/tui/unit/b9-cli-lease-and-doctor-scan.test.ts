/**
 * B9（2026-11-25）：CLI 跨进程租约门禁与 doctor 状态扫描分支。
 *
 * 覆盖 `refuseIfMissionActiveElsewhere`（取消被拒）与 `scanMissionStateDirectory`
 * （损坏 mission / 活动租约 / 过期租约计数）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  executeCancelCommand,
  executeDoctorCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-lease-"));
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
      prompt: "租约门禁",
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

async function writeLease(
  missionIdentifier: string,
  options: { processInstanceId: string; renewsUntilIso: string },
): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectory, "mission-lease.json"),
    JSON.stringify({
      schemaVersion: 1,
      leaseRevision: 1,
      missionId: missionIdentifier,
      processInstanceId: options.processInstanceId,
      agentInstanceId: null,
      purpose: "run",
      claimedAtIso: new Date().toISOString(),
      renewsUntilIso: options.renewsUntilIso,
      claimantDescription: "另一进程",
    }),
    "utf8",
  );
}

describe("B9：CLI 租约门禁与 doctor 扫描", () => {
  it("① 取消：其他进程持有活动租约 ⇒ 退出 1 且说明拒绝原因", async () => {
    const missionIdentifier = await createMission();
    await writeLease(missionIdentifier, {
      processInstanceId: "process-other",
      renewsUntilIso: new Date(Date.now() + 60_000).toISOString(),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error("process-exit:" + String(code));
    }) as never);
    try {
      await expect(
        executeCancelCommand({
          stateDirectory,
          missionId: missionIdentifier,
          isJsonOutput: false,
        }),
      ).rejects.toThrow("process-exit:1");
      expect(text()).toContain("其他进程");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("② doctor：损坏 mission + 活动租约 + 过期租约都被统计，健康为 failed", async () => {
    const corruptedIdentifier = "mission-corrupt";
    const corruptedDirectory = path.join(stateDirectory, "missions", corruptedIdentifier);
    await fs.mkdir(corruptedDirectory, { recursive: true });
    await fs.writeFile(path.join(corruptedDirectory, "summary.json"), "{ 损坏", "utf8");

    await writeLease("mission-active", {
      processInstanceId: "process-other",
      renewsUntilIso: new Date(Date.now() + 60_000).toISOString(),
    });
    await writeLease("mission-stale", {
      processInstanceId: "process-other",
      renewsUntilIso: new Date(Date.now() - 60_000).toISOString(),
    });

    const exitCode = await executeDoctorCommand({
      stateDirectory,
      applicationRootPath: process.cwd(),
      isJsonOutput: true,
    } as never);
    const parsed = JSON.parse(text()) as {
      missionState: { corruptedCount: number; activeLeaseCount: number; staleLeaseCount: number };
      health: string;
    };
    expect(exitCode).toBe(1);
    expect(parsed.missionState.corruptedCount).toBeGreaterThanOrEqual(1);
    expect(parsed.missionState.activeLeaseCount).toBeGreaterThanOrEqual(1);
    expect(parsed.missionState.staleLeaseCount).toBeGreaterThanOrEqual(1);
    expect(parsed.health).toBe("failed");
  });
});
