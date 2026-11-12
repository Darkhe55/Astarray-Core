/**
 * 目标 ↔ mission 绑定存储（此前 `tests/` 零引用）：**mission 只能绑定一个目标，且不得静默改绑**。
 *
 * 反例优先：缺标识拒绝 / 同 mission 换 goal 拒绝 / 同参数重复绑定幂等（不涨 revision）/
 * 损坏文档读作空（不伪造绑定，否则门禁会被"凭空绑定"误导）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoalMissionBindingStore } from "../../../packages/core/src/orchestration/goal-mission-binding-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "goal-binding-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore() {
  return new GoalMissionBindingStore({ baseDirectory });
}

function bindInput(overrides: Record<string, unknown> = {}) {
  return {
    missionIdentifier: "mission-1",
    goalIdentifier: "goal-1",
    boundAtIso: "2026-11-12T00:00:00.000Z",
    ...overrides,
  } as never;
}

describe("目标 mission 绑定", () => {
  it("① 缺 mission 或 goal 标识 ⇒ 拒绝", async () => {
    const store = buildStore();
    await expect(store.bind(bindInput({ missionIdentifier: " " }))).rejects.toThrow(/必须同时提供/u);
    await expect(store.bind(bindInput({ goalIdentifier: "" }))).rejects.toThrow(/必须同时提供/u);
  });

  it("② 首次绑定 ⇒ 落盘且 revision 递增，可读回", async () => {
    const store = buildStore();
    await store.bind(bindInput());
    const document = await store.read();
    expect(document.documentRevision).toBe(1);
    expect(document.bindings).toHaveLength(1);
    expect(await store.readGoalIdentifier("mission-1")).toBe("goal-1");
  });

  it("③ 同 mission 同 goal 重复绑定 ⇒ 幂等（不新增、不涨 revision）", async () => {
    const store = buildStore();
    await store.bind(bindInput());
    await store.bind(bindInput({ boundAtIso: "2026-11-12T01:00:00.000Z" }));
    const document = await store.read();
    expect(document.bindings).toHaveLength(1);
    expect(document.documentRevision).toBe(1);
    expect(document.bindings[0]?.boundAtIso).toBe("2026-11-12T00:00:00.000Z");
  });

  it("④ 同 mission 换目标 ⇒ 拒绝改绑（权限错误码）", async () => {
    const store = buildStore();
    await store.bind(bindInput());
    await expect(
      store.bind(bindInput({ goalIdentifier: "goal-2" })),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(await store.readGoalIdentifier("mission-1")).toBe("goal-1");
  });

  it("⑤ 同一目标可被多个 mission 引用（按 mission 判重，不按 goal 独占）", async () => {
    const store = buildStore();
    await store.bind(bindInput({ missionIdentifier: "mission-1" }));
    await store.bind(bindInput({ missionIdentifier: "mission-2" }));
    const bindings = await store.list();
    expect(bindings.map((binding) => binding.missionIdentifier).sort()).toEqual([
      "mission-1",
      "mission-2",
    ]);
  });

  it("⑥ unbind ⇒ true 且生效；再次 unbind ⇒ false", async () => {
    const store = buildStore();
    await store.bind(bindInput());
    expect(await store.unbind("mission-1")).toBe(true);
    expect(await store.readGoalIdentifier("mission-1")).toBeNull();
    expect(await store.unbind("mission-1")).toBe(false);
  });

  it("⑦ 文档损坏 ⇒ 读作空（不伪造绑定）", async () => {
    const store = buildStore();
    const goalModeDirectory = path.join(baseDirectory, "goal-mode");
    await fs.mkdir(goalModeDirectory, { recursive: true });
    await fs.writeFile(
      path.join(goalModeDirectory, "mission-bindings.json"),
      JSON.stringify({ bindings: "not-an-array" }),
      "utf8",
    );
    const document = await store.read();
    expect(document.bindings).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.readGoalIdentifier("mission-1")).toBeNull();
  });
});
