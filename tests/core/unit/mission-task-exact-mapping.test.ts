/**
 * WIRING-04-04（方案 A）：**精确任务级映射**的建立规则。
 *
 * 用户裁决：给 mission 任务节点加来源字段（序列任务 / 序列标识 / 属主），
 * 三者齐全才建立精确映射；缺一个就**不写**（不按名称、最近任务或通配兜底）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MissionTaskSequenceMapStore,
  bindExactMissionTaskMapping,
} from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-exact-mapping-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): MissionTaskSequenceMapStore {
  return new MissionTaskSequenceMapStore({ baseDirectory: stateDirectory });
}

const fullSource = {
  sourceSequenceTaskIdentifier: "seq-task-7",
  sourceSequenceIdentifier: "sequence-1",
  sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
};

describe("WIRING-04-04 精确映射", () => {
  it("① 来源齐全 ⇒ 建立精确映射（不是通配）", async () => {
    const store = buildStore();
    const result = await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-003",
      ...fullSource,
    });
    expect(result.outcome).toBe("bound");

    const entries = await store.listForMission({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "sequence-1",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      missionTaskIdentifier: "T-003",
      sequenceTaskIdentifier: "seq-task-7",
      ownerAgentInstanceIdentifier: "agent-1",
    });
    expect(entries.some((entry) => entry.missionTaskIdentifier === "*")).toBe(false);
  }, 30_000);

  it("② 来源缺一个 ⇒ 不写（返回 skipped-missing-source）", async () => {
    const store = buildStore();
    const result = await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-003",
      sourceSequenceTaskIdentifier: "seq-task-7",
      sourceSequenceIdentifier: "sequence-1",
    });
    expect(result.outcome).toBe("skipped-missing-source");
    const entries = await store.listForMission({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "sequence-1",
    });
    expect(entries).toHaveLength(0);
  }, 30_000);

  it("③ 通配任务标识 ⇒ 拒绝（不得把整 mission 关联当精确映射）", async () => {
    const store = buildStore();
    const result = await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "*",
      ...fullSource,
    });
    expect(result.outcome).toBe("skipped-missing-source");
    expect(
      await store.listForMission({
        missionIdentifier: "mission-1",
        sequenceIdentifier: "sequence-1",
      }),
    ).toHaveLength(0);
  }, 30_000);

  it("④ 同名任务不串包：两个 mission 任务各绑自己的序列节点", async () => {
    const store = buildStore();
    await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-003",
      ...fullSource,
    });
    await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-004",
      sourceSequenceTaskIdentifier: "seq-task-8",
      sourceSequenceIdentifier: "sequence-1",
      sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
    });
    const entries = await store.listForMission({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "sequence-1",
    });
    expect(
      entries.map((entry) => [entry.missionTaskIdentifier, entry.sequenceTaskIdentifier]),
    ).toEqual([
      ["T-003", "seq-task-7"],
      ["T-004", "seq-task-8"],
    ]);
  }, 30_000);
});
