/** GUI-03-03：手动调整排队指令顺序。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InstructionWindowStore } from "../../../packages/core/src/orchestration/instruction-window-store.js";

const directories: string[] = [];
async function createStore(): Promise<InstructionWindowStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-priority-"));
  directories.push(directory);
  return new InstructionWindowStore({ baseDirectory: directory, windowCapacity: 1 });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function admit(store: InstructionWindowStore, id: string) {
  return store.admitInstruction({
    instructionIdentifier: id,
    instructionRevision: 1,
    sourceKind: "user",
    instructionText: "指令 " + id,
    idempotencyKey: "key-" + id,
  });
}

describe("排队指令手动置顶", () => {
  it("① 把后入队指令移到队首，其他顺序保持", async () => {
    const store = await createStore();
    await admit(store, "ins-1");
    await admit(store, "ins-2");
    await admit(store, "ins-3");
    const moved = await store.moveQueuedInstructionToFront("ins-3");
    expect(moved.moved).toBe(true);
    const snapshot = await store.snapshot();
    expect(snapshot.queuedInstructions.map((item) => item.instructionIdentifier)).toEqual([
      "ins-3",
      "ins-2",
    ]);
  });

  it("② 非排队指令不改变顺序", async () => {
    const store = await createStore();
    await admit(store, "ins-1");
    const moved = await store.moveQueuedInstructionToFront("missing");
    expect(moved.moved).toBe(false);
  });
});
