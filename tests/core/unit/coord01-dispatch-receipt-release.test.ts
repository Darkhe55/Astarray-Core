/**
 * COORD-01-03 §5：**交办回执释放槽位**（不等待下级最终产物）。
 *
 * 反例优先：
 * - 交办**失败** ⇒ 不释放（`dispatch-failed-no-release`，槽位仍被占用）；
 * - 交办成功 ⇒ 释放并补位，状态为 `handed-off`（区别于 `completed`）；
 * - 重复交办回执 ⇒ 幂等忽略；
 * - 执行完成回执仍按原语义走 `completed`。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstructionWindowStore } from "../../../packages/core/src/orchestration/instruction-window-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-dispatch-receipt-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function admit(store: InstructionWindowStore, identifier: string) {
  const result = await store.admitInstruction({
    instructionIdentifier: identifier,
    instructionText: "执行 " + identifier,
    instructionRevision: 1,
  } as never);
  expect(result.outcome).toBe("admitted");
}

function buildReceipt(overrides: Record<string, unknown> = {}) {
  return {
    instructionIdentifier: "instruction-1",
    instructionRevision: 1,
    receiptOutcome: "completed",
    taskIdentifiers: ["T-001"],
    evidenceReferences: [],
    unresolvedQuestions: [],
    ...overrides,
  } as never;
}

describe("交办回执释放槽位", () => {
  it("① 交办成功 ⇒ 释放槽位且状态为 handed-off", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    await admit(store, "instruction-1");
    const result = await store.submitReceipt(
      buildReceipt({ receiptKind: "dispatch", receiptOutcome: "completed" }),
    );
    expect(result.outcome).toBe("released-no-backfill");
    const snapshot = await store.snapshot();
    expect(
      snapshot.terminalInstructions.find((item) => item.instructionIdentifier === "instruction-1")?.state,
    ).toBe("handed-off");
  });

  it("② 交办**失败** ⇒ 不释放槽位", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    await admit(store, "instruction-1");
    const result = await store.submitReceipt(
      buildReceipt({ receiptKind: "dispatch", receiptOutcome: "failed" }),
    );
    expect(result.outcome).toBe("dispatch-failed-no-release");
    const snapshot = await store.snapshot();
    expect(
      snapshot.activeInstructions.find((item) => item.instructionIdentifier === "instruction-1")?.state,
    ).toBe("dispatched");
  });

  it("③ 重复交办回执 ⇒ 幂等忽略（只释放一次）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    await admit(store, "instruction-1");
    const first = await store.submitReceipt(buildReceipt({ receiptKind: "dispatch" }));
    expect(first.outcome).toBe("released-no-backfill");
    const second = await store.submitReceipt(buildReceipt({ receiptKind: "dispatch" }));
    expect(second.outcome).toBe("duplicate-receipt-ignored");
  });

  it("④ 执行完成回执仍走 completed（与交办回执分开）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    await admit(store, "instruction-1");
    await store.submitReceipt(buildReceipt({ receiptKind: "completion" }));
    const snapshot = await store.snapshot();
    expect(
      snapshot.terminalInstructions.find((item) => item.instructionIdentifier === "instruction-1")?.state,
    ).toBe("completed");
  });
});
