/**
 * B9（2026-11-25）：mission 任务 ↔ 权威序列节点的精确映射（绑定/幂等/改绑拒绝/清理）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MissionTaskSequenceMapStore,
  bindExactMissionTaskMapping,
} from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";

let baseDirectory: string;
let store: MissionTaskSequenceMapStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-task-map-"));
  store = new MissionTaskSequenceMapStore({ baseDirectory });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function bindInput(overrides: Record<string, unknown> = {}) {
  return {
    missionIdentifier: "mission-1",
    sequenceIdentifier: "seq-1",
    ownerAgentInstanceIdentifier: "agent-1",
    missionTaskIdentifier: "T-1",
    sequenceTaskIdentifier: "seq-task-1",
    ...overrides,
  };
}

describe("B9：mission 任务序列映射", () => {
  it("① 精确绑定：三字段齐全才写；缺字段或通配 ⇒ skipped-missing-source", async () => {
    const skipped = await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-1",
      sourceSequenceTaskIdentifier: "seq-task-1",
    });
    expect(skipped.outcome).toBe("skipped-missing-source");

    const wildcard = await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "*",
      sourceSequenceTaskIdentifier: "seq-task-1",
      sourceSequenceIdentifier: "seq-1",
      sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
    });
    expect(wildcard.outcome).toBe("skipped-missing-source");

    const bound = await bindExactMissionTaskMapping({
      store,
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-1",
      sourceSequenceTaskIdentifier: "seq-task-1",
      sourceSequenceIdentifier: "seq-1",
      sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
    });
    expect(bound.outcome).toBe("bound");
  });

  it("② 绑定幂等：同任务同节点重复绑定 ⇒ didWrite=false 且只有一条", async () => {
    expect((await store.bind(bindInput() as never)).didWrite).toBe(true);
    expect((await store.bind(bindInput() as never)).didWrite).toBe(false);
    expect(await store.listForMission({ missionIdentifier: "mission-1", sequenceIdentifier: "seq-1" }))
      .toHaveLength(1);
  });

  it("③ 同任务改绑不同节点 ⇒ journal-corrupted（不静默改绑）", async () => {
    await store.bind(bindInput() as never);
    await expect(
      store.bind(bindInput({ sequenceTaskIdentifier: "seq-task-2" }) as never),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("④ listForMission：按 mission+sequence 过滤；不同序列不返回", async () => {
    await store.bind(bindInput() as never);
    await store.bind(
      bindInput({ sequenceIdentifier: "seq-2", missionTaskIdentifier: "T-2", sequenceTaskIdentifier: "seq-task-2" }) as never,
    );
    expect(
      await store.listForMission({ missionIdentifier: "mission-1", sequenceIdentifier: "seq-1" }),
    ).toHaveLength(1);
    expect(
      await store.listForMission({ missionIdentifier: "mission-1", sequenceIdentifier: "seq-missing" }),
    ).toEqual([]);
  });

  it("⑤ removeForMissionTask：只删匹配任务；通配 * 不动；不存在返回 0", async () => {
    await store.bind(bindInput() as never);
    await store.bind(
      bindInput({ missionTaskIdentifier: "*", sequenceTaskIdentifier: "seq-task-all" }) as never,
    );
    expect(
      (await store.removeForMissionTask({ missionIdentifier: "mission-1", missionTaskIdentifier: "T-1" })).removedCount,
    ).toBe(1);
    expect(
      (await store.removeForMissionTask({ missionIdentifier: "mission-1", missionTaskIdentifier: "*" })).removedCount,
    ).toBe(0);
    expect(
      (await store.removeForMissionTask({ missionIdentifier: "mission-1", missionTaskIdentifier: "T-404" })).removedCount,
    ).toBe(0);
    expect(await store.listForMission({ missionIdentifier: "mission-1", sequenceIdentifier: "seq-1" }))
      .toHaveLength(1);
  });

  it("⑥ 损坏文件/缺字段条目 ⇒ 过滤为可用映射（不伪造）", async () => {
    const ledgerDirectory = path.join(baseDirectory, "task-ledger");
    await fs.mkdir(ledgerDirectory, { recursive: true });
    await fs.writeFile(
      path.join(ledgerDirectory, "mission-task-maps.json"),
      JSON.stringify({
        schemaVersion: 1,
        documentRevision: 3,
        maps: [{ missionIdentifier: "mission-1" }, "bad", null],
      }),
      "utf8",
    );
    const document = await store.read();
    expect(document.maps).toEqual([]);
  });
});
