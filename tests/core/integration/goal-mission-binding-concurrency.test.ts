/**
 * WIRING-04 §36.2 反例：mission↔目标归属绑定（2026-11-19）。
 *
 * 归属绑定决定任务属于哪个目标：并发绑定若互相覆盖，会把任务挂到错误目标下。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoalMissionBindingStore } from "../../../packages/core/src/orchestration/goal-mission-binding-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "goal-binding-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): GoalMissionBindingStore {
  return new GoalMissionBindingStore({ baseDirectory: stateDirectory });
}

describe("WIRING-04 §36.2：mission 归属绑定并发", () => {
  it("① 两个实例并发绑定 40 个 mission ⇒ 40 条绑定都保留", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const binds: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      binds.push(
        firstStore.bind({
          missionIdentifier: `mission-a-${String(index)}`,
          goalIdentifier: "goal-1",
          boundAtIso: "2026-11-18T00:00:00.000Z",
        }),
        secondStore.bind({
          missionIdentifier: `mission-b-${String(index)}`,
          goalIdentifier: "goal-1",
          boundAtIso: "2026-11-18T00:00:00.000Z",
        }),
      );
    }
    await Promise.all(binds);

    const bindings = await buildStore().list();
    expect(bindings).toHaveLength(40);
  }, 60_000);
});
