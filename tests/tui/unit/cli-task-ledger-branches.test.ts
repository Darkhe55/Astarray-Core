/**
 * B9（2026-11-24）：`task-ledger` 只读视图与缺参分支（本地状态目录，无运行时）。
 *
 * 覆盖：绑定索引空/非空（文本/JSON）、缺参（missing-inputs）、索引缺失（index-missing, exit 2）、
 * 推迟插入队列空/非空与 mission 过滤、单任务预检失败路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { DeferredInsertionQueueStore } from "../../../packages/core/src/orchestration/deferred-insertion-queue.js";
import { MissionSequenceBindingStore } from "../../../packages/core/src/orchestration/mission-sequence-binding-store.js";
import { executeTaskLedgerStatusCommand } from "../../../packages/tui/src/cli/task-ledger-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ledger-cli-"));
});

afterEach(async () => {
  process.exitCode = undefined;
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

async function run(action: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

describe("B9：task-ledger 只读视图", () => {
  it("① list-bindings：空索引（文本「索引为空」/JSON no-bindings）", async () => {
    const text = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        isListBindings: true,
        isJsonOutput: false,
      }),
    );
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain("索引为空");

    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        isListBindings: true,
        isJsonOutput: true,
      }),
    );
    expect(JSON.parse(json.output)).toMatchObject({ status: "no-bindings", bindingCount: 0 });
  });

  it("② list-bindings：已登记绑定（文本/JSON 列出映射）", async () => {
    const store = new MissionSequenceBindingStore({ baseDirectory: stateDirectory });
    await store.bind({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "seq-1",
      ownerAgentInstanceIdentifier: "agent-1",
      boundAtIso: "2026-11-24T00:00:00.000Z",
    });
    const text = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isListBindings: true, isJsonOutput: false }),
    );
    expect(text.output).toContain("mission-1 → seq-1");
    const json = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isListBindings: true, isJsonOutput: true }),
    );
    expect(JSON.parse(json.output)).toMatchObject({ status: "listed", bindingCount: 1 });
  });

  it("③ deferred-insertions：空队列（文本/JSON）", async () => {
    const text = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        isListDeferredInsertions: true,
        isJsonOutput: false,
      }),
    );
    expect(text.output).toContain("没有待消费的推迟插入");
    expect(text.output).toContain("未截断");

    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        isListDeferredInsertions: true,
        isJsonOutput: true,
      }),
    );
    expect(JSON.parse(json.output)).toMatchObject({
      status: "no-pending-insertions",
      pendingCount: 0,
      droppedConsumedCount: 0,
    });
  });

  it("④ deferred-insertions：按 mission 过滤；其他 mission 不串数据", async () => {
    const queue = new DeferredInsertionQueueStore({ baseDirectory: stateDirectory });
    for (const [index, mission] of ["mission-1", "mission-2"].entries()) {
      await queue.enqueue({
        insertRequestIdentifier: `req-${String(index)}`,
        missionIdentifier: mission,
        taskIdentifier: `T-${String(index)}`,
        sequenceIdentifier: "seq-1",
        ownerAgentInstanceIdentifier: "agent-1",
        reason: "测试",
        enqueuedAtIso: "2026-11-24T00:00:00.000Z",
      });
    }
    const filtered = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-1",
        isListDeferredInsertions: true,
        isJsonOutput: true,
      }),
    );
    const parsed = JSON.parse(filtered.output) as {
      pendingCount: number;
      pendingEntries: Array<{ missionIdentifier: string }>;
    };
    expect(parsed.pendingCount).toBe(1);
    expect(parsed.pendingEntries[0]?.missionIdentifier).toBe("mission-1");
  });

  it("⑤ 无参数 ⇒ missing-inputs（exit 0），不猜映射", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({ status: "missing-inputs" });
  });

  it("⑥ 只给 mission 且索引缺失 ⇒ index-missing（exit 2）", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        isJsonOutput: true,
      }),
    );
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.output)).toMatchObject({ status: "index-missing" });
  });

  it("⑦ 单任务预检：mission 不存在 ⇒ failed（exit 2）", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-missing",
        sequenceIdentifier: "seq-missing",
        ownerAgentInstanceIdentifier: "agent-1",
        taskIdentifier: "T-1",
        isJsonOutput: true,
      }),
    );
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.output)).toMatchObject({ status: "failed" });
  });
});
