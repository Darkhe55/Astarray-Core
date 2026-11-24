/**
 * B9（2026-11-24）：`instruction` 指令窗口命令分支（本地状态目录）。
 *
 * 覆盖：空文本/空幂等键拒绝、准入（文本/JSON）、超容量排队、同键幂等复用、
 * 空窗口只读视图、未知键期限评估失败、超期如实报告（exit 0）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeInstructionAcceptCommand,
  executeInstructionDeadlineCommand,
  executeInstructionListCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory = "";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-instruction-"));
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

function baseAccept() {
  return {
    stateDirectory,
    isJsonOutput: true,
    instructionText: "改登录页",
    idempotencyKey: "key-1",
    nowIso: "2026-11-24T00:00:00.000Z",
  };
}

describe("B9：instruction accept/list", () => {
  it("① 空文本 / 空幂等键 ⇒ 用法错误（exit 2），不伪造指令", async () => {
    const restoreStderr = silenceStderr();
    try {
      expect(
        (
          await run(() =>
            executeInstructionAcceptCommand({ ...baseAccept(), instructionText: "   " }),
          )
        ).exitCode,
      ).toBe(2);
      expect(
        (
          await run(() =>
            executeInstructionAcceptCommand({ ...baseAccept(), idempotencyKey: "  " }),
          )
        ).exitCode,
      ).toBe(2);
    } finally {
      restoreStderr();
    }
  });

  it("② 首次接收 ⇒ admitted；JSON 显示窗口 1/3", async () => {
    const { exitCode, output } = await run(() => executeInstructionAcceptCommand(baseAccept()));
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as {
      admissionOutcome: string;
      activeInstructionCount: number;
      windowCapacity: number;
    };
    expect(parsed.admissionOutcome).toBe("admitted");
    expect(parsed.activeInstructionCount).toBe(1);
    expect(parsed.windowCapacity).toBe(3);
  });

  it("③ 超过容量 ⇒ 排队（不丢弃）", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await run(() =>
        executeInstructionAcceptCommand({
          ...baseAccept(),
          instructionText: `指令 ${String(index)}`,
          idempotencyKey: `key-${String(index)}`,
        }),
      );
    }
    const { output } = await run(() =>
      executeInstructionListCommand({ stateDirectory, isJsonOutput: true }),
    );
    const parsed = JSON.parse(output) as {
      activeInstructions: unknown[];
      queuedInstructions: unknown[];
      windowCapacity: number;
    };
    expect(parsed.windowCapacity).toBe(3);
    expect(parsed.activeInstructions).toHaveLength(3);
    expect(parsed.queuedInstructions).toHaveLength(1);
  });

  it("④ 同键同参 ⇒ 幂等复用（不新增）；文本输出可用", async () => {
    await run(() => executeInstructionAcceptCommand(baseAccept()));
    const second = await run(() =>
      executeInstructionAcceptCommand({
        ...baseAccept(),
        isJsonOutput: false,
      }),
    );
    expect(second.exitCode).toBe(0);
    const list = await run(() =>
      executeInstructionListCommand({ stateDirectory, isJsonOutput: true }),
    );
    const parsed = JSON.parse(list.output) as { activeInstructions: unknown[] };
    expect(parsed.activeInstructions).toHaveLength(1);
  });

  it("⑤ 空窗口只读视图：文本含 capacity/active/queued；JSON 三数组", async () => {
    const text = await run(() =>
      executeInstructionListCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(text.output).toContain("capacity: 3");
    expect(text.output).toContain("active: 0");
    expect(text.output).toContain("queued: 0");

    const json = await run(() =>
      executeInstructionListCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(JSON.parse(json.output)).toMatchObject({
      activeInstructions: [],
      queuedInstructions: [],
      terminalInstructions: [],
    });
  });
});

describe("B9：instruction deadline", () => {
  it("⑥ 未知幂等键 ⇒ 响亮失败（exit 1）", async () => {
    const restoreStderr = silenceStderr();
    try {
      const { exitCode } = await run(() =>
        executeInstructionDeadlineCommand({
          stateDirectory,
          isJsonOutput: true,
          idempotencyKey: "missing-key",
          nowIso: "2026-11-24T00:00:00.000Z",
        }),
      );
      expect(exitCode).toBe(1);
    } finally {
      restoreStderr();
    }
  });

  it("⑦ 已知键且已超期 ⇒ 如实报告 truthfully（exit 0）", async () => {
    await run(() => executeInstructionAcceptCommand(baseAccept()));
    const { exitCode, output } = await run(() =>
      executeInstructionDeadlineCommand({
        stateDirectory,
        isJsonOutput: true,
        idempotencyKey: "key-1",
        nowIso: "2026-11-24T00:10:00.000Z",
      }),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as {
      kind: string;
      isTruthfulTimeout: boolean;
      isWorkCompleted: boolean;
    };
    expect(parsed.isWorkCompleted).toBe(false);
    expect(typeof parsed.kind).toBe("string");
    expect(typeof parsed.isTruthfulTimeout).toBe("boolean");
  });
});
