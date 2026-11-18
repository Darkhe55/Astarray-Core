/**
 * 精确映射跨实例并发（2026-11-18）。
 *
 * 映射是"mission 任务 ↔ 序列节点"的唯一依据：并发绑定丢条目 ⇒
 * 解析层判 `declared-but-missing` ⇒ 任务被阻塞（或映射静默消失）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissionTaskSequenceMapStore } from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "map-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): MissionTaskSequenceMapStore {
  return new MissionTaskSequenceMapStore({ baseDirectory: stateDirectory });
}

function bindOne(store: MissionTaskSequenceMapStore, sequence: number): Promise<unknown> {
  return store.bind({
    missionIdentifier: "mission-1",
    sequenceIdentifier: "sequence-1",
    ownerAgentInstanceIdentifier: "agent-1",
    missionTaskIdentifier: `T-${String(sequence)}`,
    sequenceTaskIdentifier: `seq-task-${String(sequence)}`,
  });
}

describe("精确映射跨实例并发", () => {
  it("① 两个实例并发绑定 40 条 ⇒ 40 条映射全部可见", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const binds: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      binds.push(bindOne(firstStore, index * 2), bindOne(secondStore, index * 2 + 1));
    }
    await Promise.all(binds);

    const entries = await buildStore().listForMission({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "sequence-1",
    });
    expect(entries).toHaveLength(40);
  }, 90_000);

  it("② 同一对（mission 任务 + 序列任务）并发绑定 ⇒ 幂等且只留一条", async () => {
    await Promise.all([bindOne(buildStore(), 1), bindOne(buildStore(), 1)]);
    const entries = await buildStore().listForMission({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "sequence-1",
    });
    expect(entries).toHaveLength(1);
  }, 90_000);
});
