/**
 * mission ↔ 权威序列索引（此前 `tests/` 零引用）。
 *
 * 保守规则：一个 mission 只对应一个序列，改绑即 `journal-corrupted`；
 * 重复绑定同序列幂等且**不覆盖既有 owner/时间**；没有绑定就返回 null（不按任务名/路径猜）；损坏读作空。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MissionSequenceBindingStore } from "../../../packages/core/src/orchestration/mission-sequence-binding-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mission-sequence-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore() {
  return new MissionSequenceBindingStore({ baseDirectory });
}

function bindInput(overrides: Record<string, unknown> = {}) {
  return {
    missionIdentifier: "mission-1",
    sequenceIdentifier: "sequence-1",
    ownerAgentInstanceIdentifier: "main-agent-1",
    boundAtIso: "2026-11-12T00:00:00.000Z",
    ...overrides,
  } as never;
}

describe("mission 序列索引", () => {
  it("① 三者任一为空 ⇒ 拒绝", async () => {
    const store = buildStore();
    for (const overrides of [
      { missionIdentifier: " " },
      { sequenceIdentifier: "" },
      { ownerAgentInstanceIdentifier: "  " },
    ]) {
      await expect(store.bind(bindInput(overrides))).rejects.toThrow(/非空/u);
    }
  });

  it("② 首次绑定 ⇒ didWrite=true、revision 递增、可读回", async () => {
    const store = buildStore();
    const result = await store.bind(bindInput());
    expect(result.didWrite).toBe(true);
    const document = await store.read();
    expect(document.documentRevision).toBe(1);
    expect(await store.readForMission("mission-1")).toMatchObject({
      sequenceIdentifier: "sequence-1",
      ownerAgentInstanceIdentifier: "main-agent-1",
    });
  });

  it("③ 重复绑定同一序列 ⇒ 幂等，且不覆盖既有 owner/时间", async () => {
    const store = buildStore();
    await store.bind(bindInput());
    const second = await store.bind(
      bindInput({
        ownerAgentInstanceIdentifier: "another-owner",
        boundAtIso: "2026-11-12T05:00:00.000Z",
      }),
    );
    expect(second.didWrite).toBe(false);
    expect(second.binding.ownerAgentInstanceIdentifier).toBe("main-agent-1");
    expect(second.binding.boundAtIso).toBe("2026-11-12T00:00:00.000Z");
    expect((await store.read()).bindings).toHaveLength(1);
  });

  it("④ 同 mission 换序列 ⇒ journal-corrupted，原绑定不变", async () => {
    const store = buildStore();
    await store.bind(bindInput());
    await expect(
      store.bind(bindInput({ sequenceIdentifier: "sequence-2" })),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    expect((await store.readForMission("mission-1"))?.sequenceIdentifier).toBe("sequence-1");
  });

  it("⑤ 未绑定 mission ⇒ null（不推断），list 为空", async () => {
    const store = buildStore();
    expect(await store.readForMission("mission-unknown")).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("⑥ 文档损坏 ⇒ 读作空（宁可未知也不伪造索引）", async () => {
    const store = buildStore();
    const directory = path.join(baseDirectory, "task-ledger");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "mission-sequences.json"),
      JSON.stringify({ bindings: 42 }),
      "utf8",
    );
    expect((await store.read()).bindings).toEqual([]);
    expect(await store.readForMission("mission-1")).toBeNull();
  });
});
