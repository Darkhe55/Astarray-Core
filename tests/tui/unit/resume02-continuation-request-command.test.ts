/**
 * RESUME-02 显式请求写路径测试（2026-11-24）：
 * 关闭时拒绝；未认证拒绝；本地任务链推导状态；可续时登记回执并领取（不派发）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeContinuationRequestCommand } from "../../../packages/tui/src/cli/continuation-command.js";
import { CONTINUATION_CONFIG_FILE_NAME } from "../../../packages/tui/src/cli/continuation-command.js";

let stateDirectory: string;
const nowIso = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cont-request-"));
  delete process.env["ASTARRAY_AUTHENTICATED_USER_ID"];
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

async function enableContinuation(): Promise<void> {
  const configPath = path.join(stateDirectory, CONTINUATION_CONFIG_FILE_NAME);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ isCheckpointContinuationEnabled: true }), "utf8");
}

async function writeChain(tasks: Array<{ id: string; status: string }>): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", "mission-1");
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectory, "task-chain.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 7,
      updatedAtIso: nowIso,
      tasks: tasks.map((task) => ({
        id: task.id,
        description: "任务",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
        assignedAgentId: null,
        status: task.status,
        resultLocation: null,
      })),
    }),
    "utf8",
  );
}

describe("RESUME-02：continuation request 写路径", () => {
  it("① 关闭 ⇒ disabled（不读链、不写回执）", async () => {
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await executeContinuationRequestCommand({
        stateDirectory,
        principalIdentifier: "user-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        expectedRevision: 7,
        requestIdentifier: "req-1",
        nowIso,
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    expect(exitCode!).toBe(0);
    expect(JSON.parse(capture.lines.join(""))).toMatchObject({
      status: "disabled",
      settingReason: "config-missing",
    });
  });

  it("② 未认证 ⇒ exit 2 且不产生回执", async () => {
    await enableContinuation();
    await writeChain([{ id: "T-1", status: "pending" }]);
    let exitCode: number;
    const originalError = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      exitCode = await executeContinuationRequestCommand({
        stateDirectory,
        principalIdentifier: null,
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        expectedRevision: 7,
        requestIdentifier: "req-1",
        nowIso,
        isJsonOutput: true,
      });
    } finally {
      process.stderr.write = originalError;
    }
    expect(exitCode!).toBe(2);
    await expect(
      fs.access(path.join(stateDirectory, "resume-intent", "receipts.json")),
    ).rejects.toBeTruthy();
  });

  it("③ 任务链不存在 ⇒ nothing-to-resume（不猜）", async () => {
    await enableContinuation();
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await executeContinuationRequestCommand({
        stateDirectory,
        principalIdentifier: "user-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        expectedRevision: 7,
        requestIdentifier: "req-1",
        nowIso,
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    expect(exitCode!).toBe(0);
    expect(JSON.parse(capture.lines.join(""))).toMatchObject({
      status: "nothing-to-resume",
      reasonCode: "mission-not-found",
    });
  });

  it("④ 运行中 ⇒ still-running（不重复派发、不领取）", async () => {
    await enableContinuation();
    await writeChain([{ id: "T-1", status: "running" }]);
    const capture = captureStdout();
    try {
      await executeContinuationRequestCommand({
        stateDirectory,
        principalIdentifier: "user-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        expectedRevision: 7,
        requestIdentifier: "req-1",
        nowIso,
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    expect(JSON.parse(capture.lines.join(""))).toMatchObject({ status: "still-running" });
    await expect(
      fs.access(path.join(stateDirectory, "continuation", "claims.json")),
    ).rejects.toBeTruthy();
  });

  it("⑤ pending + 版本一致 ⇒ 登记回执并领取（token=1，不派发）", async () => {
    await enableContinuation();
    await writeChain([{ id: "T-1", status: "pending" }]);
    const capture = captureStdout();
    try {
      await executeContinuationRequestCommand({
        stateDirectory,
        principalIdentifier: "user-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        expectedRevision: 7,
        requestIdentifier: "req-1",
        nowIso,
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    const parsed = JSON.parse(capture.lines.join("")) as {
      status: string;
      claim: { fencingToken: number; taskIdentifier: string };
      note: string;
    };
    expect(parsed.status).toBe("claimed");
    expect(parsed.claim).toMatchObject({ fencingToken: 1, taskIdentifier: "T-1" });
    expect(parsed.note).toContain("≠已派发");
    const receiptDocument = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "resume-intent", "receipts.json"), "utf8"),
    ) as { receipts: Array<{ requestIdentifier: string; sourceChannel: string }> };
    expect(receiptDocument.receipts[0]).toMatchObject({
      requestIdentifier: "req-1",
      sourceChannel: "cli",
    });
  });

  it("⑥ 版本不一致 ⇒ reconciling（不领取）", async () => {
    await enableContinuation();
    await writeChain([{ id: "T-1", status: "pending" }]);
    const capture = captureStdout();
    try {
      await executeContinuationRequestCommand({
        stateDirectory,
        principalIdentifier: "user-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        expectedRevision: 6,
        requestIdentifier: "req-1",
        nowIso,
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    expect(JSON.parse(capture.lines.join(""))).toMatchObject({
      status: "reconciling",
      reasonCode: "revision-changed",
    });
  });
});
