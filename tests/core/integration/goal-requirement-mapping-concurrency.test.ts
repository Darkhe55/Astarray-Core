/**
 * 目标要求映射跨实例并发（2026-11-18）。
 *
 * 映射表记录"每条目标要求由哪些任务节点承载"：丢条目 ⇒ 要求无法判定完成。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoalRequirementMappingStore } from "../../../packages/core/src/orchestration/goal-requirement-mapping-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "goal-mapping-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): GoalRequirementMappingStore {
  return new GoalRequirementMappingStore({ baseDirectory: stateDirectory });
}

describe("目标要求映射跨实例并发", () => {
  it("① 同一 goal 并发写入 40 条要求映射 ⇒ 40 条全部保留", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      writes.push(
        firstStore.setMapping({
          goalIdentifier: "goal-1",
          contractRevision: 1,
          requirementIdentifier: `requirement-a-${String(index)}`,
          taskNodeIdentifiers: [`T-a-${String(index)}`],
        }),
        secondStore.setMapping({
          goalIdentifier: "goal-1",
          contractRevision: 1,
          requirementIdentifier: `requirement-b-${String(index)}`,
          taskNodeIdentifiers: [`T-b-${String(index)}`],
        }),
      );
    }
    await Promise.all(writes);

    const document = await buildStore().read("goal-1");
    expect(document?.mappings).toHaveLength(40);
  }, 90_000);
});
