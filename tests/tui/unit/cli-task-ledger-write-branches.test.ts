/**
 * B9（2026-11-24）：任务台账写入命令的拒绝路径。
 *
 * 覆盖：写回/绑定缺少序列索引（exit 2，文本/JSON）、mission 不存在（响亮失败）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeTaskLedgerApplyWriteBackCommand,
  executeTaskLedgerBindTaskMapCommand,
} from "../../../packages/tui/src/cli/task-ledger-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ledger-write-"));
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

describe("B9：task-ledger 写入拒绝路径", () => {
  it("① 写回：无索引且未显式给序列 ⇒ index-missing（exit 2，JSON）", async () => {
    const { exitCode, output } = await run(() =>
      executeTaskLedgerApplyWriteBackCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        approvedBy: "user-1",
        expectedSequenceRevision: 1,
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ status: "index-missing" });
  });

  it("② 绑定映射：无索引（文本）⇒ 诊断输出 + exit 2", async () => {
    const restoreStderr = silenceStderr();
    try {
      const { exitCode } = await run(() =>
        executeTaskLedgerBindTaskMapCommand({
          stateDirectory,
          missionIdentifier: "mission-missing",
          missionTaskIdentifier: "*",
          sequenceTaskIdentifier: "T-1",
          isJsonOutput: false,
        }),
      );
      expect(exitCode).toBe(2);
    } finally {
      restoreStderr();
    }
  });

  it("③ 绑定映射：显式索引但 mission 不存在 ⇒ 响亮失败", async () => {
    await expect(
      executeTaskLedgerBindTaskMapCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        sequenceIdentifier: "seq-1",
        ownerAgentInstanceIdentifier: "agent-1",
        missionTaskIdentifier: "*",
        sequenceTaskIdentifier: "T-1",
        isJsonOutput: true,
      }),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });
  });

  it("④ 写回：显式索引但序列/mission 不存在 ⇒ 响亮失败（不写任何节点）", async () => {
    await expect(
      executeTaskLedgerApplyWriteBackCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        sequenceIdentifier: "seq-1",
        ownerAgentInstanceIdentifier: "agent-1",
        approvedBy: "user-1",
        expectedSequenceRevision: 1,
        isJsonOutput: true,
      }),
    ).rejects.toThrow(/序列不存在|任务不存在/u);
  });
});
