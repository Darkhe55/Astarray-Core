/**
 * B9（2026-11-25）：目标↔mission 绑定存储（校验、幂等、改绑拒绝、解绑）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoalMissionBindingStore } from "../../../packages/core/src/orchestration/goal-mission-binding-store.js";

let baseDirectory: string;
let store: GoalMissionBindingStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-goal-bind-"));
  store = new GoalMissionBindingStore({ baseDirectory });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("B9：目标 mission 绑定", () => {
  it("① 缺 mission/goal 标识 ⇒ invalid-task-chain；不写文件", async () => {
    await expect(
      store.bind({ missionIdentifier: "  ", goalIdentifier: "goal-1", boundAtIso: "2026-11-25T00:00:00.000Z" }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    await expect(
      store.bind({ missionIdentifier: "mission-1", goalIdentifier: "", boundAtIso: "2026-11-25T00:00:00.000Z" }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    expect(await store.list()).toEqual([]);
  });

  it("② 绑定幂等：重复绑定同一对 ⇒ 返回既有且列表只有一条", async () => {
    const input = {
      missionIdentifier: "mission-1",
      goalIdentifier: "goal-1",
      boundAtIso: "2026-11-25T00:00:00.000Z",
    };
    const first = await store.bind(input);
    const second = await store.bind(input);
    expect(second).toEqual(first);
    expect(await store.list()).toHaveLength(1);
    expect(await store.readGoalIdentifier("mission-1")).toBe("goal-1");
  });

  it("③ 改绑到不同目标 ⇒ task-sequence-permission-denied（须先解绑）", async () => {
    await store.bind({
      missionIdentifier: "mission-1",
      goalIdentifier: "goal-1",
      boundAtIso: "2026-11-25T00:00:00.000Z",
    });
    await expect(
      store.bind({
        missionIdentifier: "mission-1",
        goalIdentifier: "goal-2",
        boundAtIso: "2026-11-25T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("④ 解绑：未知 ⇒ false；已知 ⇒ true 且读回 null", async () => {
    expect(await store.unbind("mission-missing")).toBe(false);
    await store.bind({
      missionIdentifier: "mission-1",
      goalIdentifier: "goal-1",
      boundAtIso: "2026-11-25T00:00:00.000Z",
    });
    expect(await store.unbind("mission-1")).toBe(true);
    expect(await store.readGoalIdentifier("mission-1")).toBeNull();
  });

  it("⑤ 未知 mission 读取 ⇒ null；缺 bindings 数组的文档 ⇒ 空", async () => {
    expect(await store.readGoalIdentifier("mission-missing")).toBeNull();

    const directoryPath = path.join(baseDirectory, "goal-mode");
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(
      path.join(directoryPath, "mission-bindings.json"),
      JSON.stringify({ schemaVersion: 1, documentRevision: 2 }),
      "utf8",
    );
    expect(await store.list()).toEqual([]);
  });
});
