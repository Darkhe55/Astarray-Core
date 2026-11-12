/**
 * ALIGN-03 / 目标模式：**门禁缓存还原**（此前 `tests/` 零引用）。
 *
 * 还原语义必须"宁可不还原也不放错"：契约缺失、状态缺失、实验关闭、revision 不匹配、
 * 快照非法 —— 任何一种都不得把门禁放回缓存（放回就等于让无约束的目标派发继续跑）。
 */
import { describe, expect, it } from "vitest";

import { GoalGateCache } from "../../../packages/core/src/orchestration/goal-gate-cache.js";

interface Binding {
  missionIdentifier: string;
  goalIdentifier: string;
}

function buildCache(options: {
  bindings: Binding[];
  contracts?: Record<string, unknown>;
  states?: Record<string, unknown>;
}) {
  return new GoalGateCache({
    bindingStore: { list: async () => options.bindings },
    contractStore: {
      read: async (goalIdentifier: string) => options.contracts?.[goalIdentifier] ?? null,
    },
    stateStore: {
      read: async (goalIdentifier: string) => options.states?.[goalIdentifier] ?? null,
    },
  } as never);
}

describe("目标门禁缓存还原", () => {
  it("① 无绑定 ⇒ 空缓存、无问题", async () => {
    const cache = buildCache({ bindings: [] });
    const result = await cache.hydrate();
    expect(result).toEqual({ restoredCount: 0, issues: [] });
    expect(cache.size()).toBe(0);
    expect(cache.resolve("mission-1")).toBeNull();
  });

  it("② 契约缺失 ⇒ contract-missing，不还原", async () => {
    const cache = buildCache({
      bindings: [{ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }],
      contracts: {},
      states: { "goal-1": { isExperimentClosed: false, contractRevision: 1 } },
    });
    const result = await cache.hydrate();
    expect(result.restoredCount).toBe(0);
    expect(result.issues).toEqual([
      { missionIdentifier: "mission-1", goalIdentifier: "goal-1", reason: "contract-missing" },
    ]);
    expect(cache.resolve("mission-1")).toBeNull();
  });

  it("③ 状态缺失 ⇒ state-missing，不还原", async () => {
    const cache = buildCache({
      bindings: [{ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }],
      contracts: { "goal-1": { revision: 1 } },
      states: {},
    });
    const result = await cache.hydrate();
    expect(result.issues[0]?.reason).toBe("state-missing");
    expect(cache.size()).toBe(0);
  });

  it("④ 实验已关闭 ⇒ experiment-closed（关闭后不再还原门禁）", async () => {
    const cache = buildCache({
      bindings: [{ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }],
      contracts: { "goal-1": { revision: 1 } },
      states: { "goal-1": { isExperimentClosed: true, contractRevision: 1 } },
    });
    const result = await cache.hydrate();
    expect(result.issues[0]?.reason).toBe("experiment-closed");
    expect(cache.resolve("mission-1")).toBeNull();
  });

  it("⑤ revision 不匹配 ⇒ revision-mismatch，不还原", async () => {
    const cache = buildCache({
      bindings: [{ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }],
      contracts: { "goal-1": { revision: 2 } },
      states: { "goal-1": { isExperimentClosed: false, contractRevision: 1 } },
    });
    const result = await cache.hydrate();
    expect(result.issues[0]?.reason).toBe("revision-mismatch");
    expect(cache.size()).toBe(0);
  });

  it("⑥ 快照非法 ⇒ restore-failed（宁可失败也不放回半截门禁）", async () => {
    const cache = buildCache({
      bindings: [{ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }],
      contracts: { "goal-1": { revision: 1 } },
      states: {
        "goal-1": { isExperimentClosed: false, contractRevision: 1, gateSnapshot: { broken: true } },
      },
    });
    const result = await cache.hydrate();
    expect(result.issues[0]?.reason).toBe("restore-failed");
    expect(cache.size()).toBe(0);
  });

  it("⑦ hydrate 是**重建**而非累加：第二次仍失败则缓存为空且问题不重复堆积", async () => {
    const cache = buildCache({
      bindings: [{ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }],
      contracts: {},
      states: {},
    });
    await cache.hydrate();
    const second = await cache.hydrate();
    expect(cache.size()).toBe(0);
    expect(second.issues).toHaveLength(1);
    expect(cache.getHydrationResult()).toEqual(second);
  });
});
