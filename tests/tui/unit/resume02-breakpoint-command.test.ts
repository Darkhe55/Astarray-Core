/**
 * RESUME-02 产品路径 CLI（断点驱动）测试（2026-11-24）：
 * 空会话只读；未带幂等键/非法 revision 用法错误；未知断点如实 not-found。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeContinuationBreakpointsCommand,
  executeContinuationResumeCommand,
} from "../../../packages/tui/src/cli/continuation-breakpoint-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-canon-cont-"));
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

describe("RESUME-02 产品路径 CLI", () => {
  it("① breakpoints：空会话 ⇒ 明确「没有断点记录」（不猜）", async () => {
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await executeContinuationBreakpointsCommand({
        stateDirectory,
        conversationIdentifier: "conv-empty",
        isJsonOutput: false,
      });
    } finally {
      capture.restore();
    }
    expect(exitCode).toBe(0);
    expect(capture.text()).toContain("没有断点记录");
  });

  it("② breakpoints --json ⇒ 空数组", async () => {
    const capture = captureStdout();
    try {
      await executeContinuationBreakpointsCommand({
        stateDirectory,
        conversationIdentifier: "conv-empty",
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    expect(JSON.parse(capture.text())).toEqual([]);
  });

  it("③ resume：缺幂等键 ⇒ 用法错误（exit 2），不进入门禁", async () => {
    const originalError = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let exitCode: number;
    try {
      exitCode = await executeContinuationResumeCommand({
        stateDirectory,
        breakpointIdentifier: "bp-1",
        missionIdentifier: "m-1",
        expectedRevision: 1,
        requestIdentifier: "  ",
        isJsonOutput: false,
      });
    } finally {
      process.stderr.write = originalError;
    }
    expect(exitCode).toBe(2);
  });

  it("④ resume：未知断点 ⇒ not-found，如实返回（exit 0）", async () => {
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await executeContinuationResumeCommand({
        stateDirectory,
        breakpointIdentifier: "bp-missing",
        missionIdentifier: "m-missing",
        expectedRevision: 0,
        requestIdentifier: "req-1",
        isJsonOutput: true,
      });
    } finally {
      capture.restore();
    }
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(capture.text()) as { outcome: string };
    expect(parsed.outcome).toBe("not-found");
  });
});
