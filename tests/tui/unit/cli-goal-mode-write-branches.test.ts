/**
 * B9（2026-11-24）：`goal-mode propose/confirm` 参数校验与失败路径。
 *
 * 覆盖：提案 JSON 无法解析（exit 2）、合法提案生成 proposal（文本/JSON）、
 * 未显式 --yes 拒绝确认（exit 2）、确认不存在的提案 ⇒ 响亮失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import {
  executeGoalModeConfirmCommand,
  executeGoalModeProposeCommand,
} from "../../../packages/tui/src/cli/goal-mode-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-goal-write-"));
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

const validDraft = JSON.stringify({
  objectiveText: "交付演示目标",
  requirements: [
    {
      requirementIdentifier: "R1",
      description: "完成演示",
      weight: 1,
      completionPredicateKind: "deterministic-check",
    },
  ],
  scope: { projectIdentifiers: ["project-demo"], allowedToolNames: null },
  nonViolableInvariants: ["不得删除用户数据"],
  resourceLimits: {
    maximumToolCalls: 10,
    maximumWallClockSeconds: 600,
    maximumCostUnits: null,
  },
  deadlineIso: null,
  pauseConditions: ["用户要求暂停"],
});

describe("B9：goal-mode propose/confirm", () => {
  it("① 提案 JSON 无法解析 ⇒ usage error（exit 2）", async () => {
    const restoreStderr = silenceStderr();
    try {
      const { exitCode } = await run(() =>
        executeGoalModeProposeCommand({
          stateDirectory,
          isJsonOutput: true,
          draftJson: "{not-json",
          sourceRequestReference: "req-1",
        }),
      );
      expect(exitCode).toBe(2);
    } finally {
      restoreStderr();
    }
  });

  it("② 合法提案 ⇒ JSON/文本均给出 proposalIdentifier", async () => {
    const json = await run(() =>
      executeGoalModeProposeCommand({
        stateDirectory,
        isJsonOutput: true,
        draftJson: validDraft,
        sourceRequestReference: "req-1",
      }),
    );
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.output) as { status: string; proposalIdentifier: string };
    expect(parsed.status).toBe("goal-proposal-created");
    expect(parsed.proposalIdentifier.length).toBeGreaterThan(0);

    const text = await run(() =>
      executeGoalModeProposeCommand({
        stateDirectory,
        isJsonOutput: false,
        draftJson: validDraft,
        sourceRequestReference: "req-2",
      }),
    );
    expect(text.output).toContain("提案已创建");
    expect(text.output).toContain("goal-mode confirm");
  });

  it("③ 未显式 --yes ⇒ 拒绝确认（exit 2，不激活目标模式）", async () => {
    const restoreStderr = silenceStderr();
    try {
      const { exitCode } = await run(() =>
        executeGoalModeConfirmCommand({
          stateDirectory,
          isJsonOutput: true,
          proposalIdentifier: "proposal-1",
          goalIdentifier: "goal-1",
          ownerIdentifier: "user-1",
          isConfirmed: false,
        }),
      );
      expect(exitCode).toBe(2);
    } finally {
      restoreStderr();
    }
  });

  it("④ 确认不存在的提案 ⇒ 响亮失败（不生成契约）", async () => {
    await expect(
      executeGoalModeConfirmCommand({
        stateDirectory,
        isJsonOutput: true,
        proposalIdentifier: "proposal-missing",
        goalIdentifier: "goal-1",
        ownerIdentifier: "user-1",
        isConfirmed: true,
      }),
    ).rejects.toThrow(/提案/u);
  });
});
