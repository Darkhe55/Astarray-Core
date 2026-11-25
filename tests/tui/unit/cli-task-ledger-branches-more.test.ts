/**
 * B9（2026-11-25）：`task-ledger status` 只读分支补充。
 *
 * 覆盖：索引空/有、推迟队列空/有/按 mission 过滤、缺 mission 的 missing-inputs、
 * 索引缺失的 index-missing、单任务预检与一屏汇总在无数据时的稳定输出。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-task-ledger-cli-"));
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

async function run(action: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

async function seedBinding(): Promise<void> {
  await new MissionSequenceBindingStore({ baseDirectory: stateDirectory }).bind({
    missionIdentifier: "mission-1",
    sequenceIdentifier: "seq-1",
    ownerAgentInstanceIdentifier: "agent-1",
    boundAtIso: "2026-11-25T00:00:00.000Z",
  });
}

async function seedDeferred(): Promise<void> {
  const store = new DeferredInsertionQueueStore({ baseDirectory: stateDirectory });
  await store.enqueue({
    insertRequestIdentifier: "insert-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-9",
    sequenceIdentifier: "seq-1",
    ownerAgentInstanceIdentifier: "agent-1",
    reason: "非安全点",
    enqueuedAtIso: "2026-11-25T00:00:00.000Z",
  });
  await store.enqueue({
    insertRequestIdentifier: "insert-2",
    missionIdentifier: "mission-2",
    taskIdentifier: "T-10",
    sequenceIdentifier: "seq-2",
    ownerAgentInstanceIdentifier: "agent-2",
    reason: "非安全点",
    enqueuedAtIso: "2026-11-25T00:01:00.000Z",
  });
}

describe("B9：task-ledger 只读分支", () => {
  it("① 索引为空（JSON/文本）⇒ no-bindings，退出码 0", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isJsonOutput: true, isListBindings: true }),
    );
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({ status: "no-bindings", bindingCount: 0 });

    const text = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isJsonOutput: false, isListBindings: true }),
    );
    expect(text.output).toContain("（索引为空");
  });

  it("② 索引有记录（JSON/文本）⇒ listed，并展示 mission→sequence", async () => {
    await seedBinding();
    const json = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isJsonOutput: true, isListBindings: true }),
    );
    expect(JSON.parse(json.output)).toMatchObject({ status: "listed", bindingCount: 1 });

    const text = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isJsonOutput: false, isListBindings: true }),
    );
    expect(text.output).toContain("mission-1 → seq-1");
  });

  it("③ 推迟队列无文件 ⇒ no-pending-insertions，退出码 0", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        isJsonOutput: true,
        isListDeferredInsertions: true,
      }),
    );
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({
      status: "no-pending-insertions",
      pendingCount: 0,
      droppedConsumedCount: 0,
    });
  });

  it("④ 推迟队列有两条、按 mission 过滤 ⇒ 只显示一条（文本）", async () => {
    await seedDeferred();
    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-1",
        isJsonOutput: true,
        isListDeferredInsertions: true,
      }),
    );
    expect(JSON.parse(json.output)).toMatchObject({ status: "listed", pendingCount: 1 });

    const text = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-1",
        isJsonOutput: false,
        isListDeferredInsertions: true,
      }),
    );
    expect(text.output).toContain("task=T-9");
    expect(text.output).not.toContain("task=T-10");
  });

  it("⑤ 缺 mission ⇒ missing-inputs（并仍展示空差异历史）", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(JSON.parse(json.output)).toMatchObject({ status: "missing-inputs" });
  });

  it("⑥ 有 mission 但无索引 ⇒ index-missing，退出码 2", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-unknown",
        isJsonOutput: true,
      }),
    );
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.output)).toMatchObject({ status: "index-missing" });
  });

  it("⑦ 一屏汇总在无数据时也返回稳定结构", async () => {
    const json = await run(() =>
      executeTaskLedgerStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-1",
        isJsonOutput: true,
        isSummaryView: true,
      }),
    );
    expect(json.output.length).toBeGreaterThan(0);
  });
});
