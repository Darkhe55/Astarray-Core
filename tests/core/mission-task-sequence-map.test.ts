/**
 * R123（2026-11-01）：mission 任务 ↔ 序列节点 映射存储与提案对齐的单测。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MissionTaskSequenceMapStore } from "../../packages/core/src/orchestration/mission-task-sequence-map-store.js";
import { TaskLedgerBridge } from "../../packages/core/src/orchestration/task-ledger-bridge.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createStore(): Promise<MissionTaskSequenceMapStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-task-map-"));
  directories.push(directory);
  return new MissionTaskSequenceMapStore({ baseDirectory: directory });
}

describe("mission 任务 ↔ 序列节点 映射", () => {
  it("登记后可读回；重复同一对幂等；改绑被拒", async () => {
    const store = await createStore();
    const first = await store.bind({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "seq-1",
      ownerAgentInstanceIdentifier: "scheduler:mission-1",
      missionTaskIdentifier: "T-01",
      sequenceTaskIdentifier: "node-a",
    });
    expect(first.didWrite).toBe(true);
    const again = await store.bind({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "seq-1",
      ownerAgentInstanceIdentifier: "scheduler:mission-1",
      missionTaskIdentifier: "T-01",
      sequenceTaskIdentifier: "node-a",
    });
    expect(again.didWrite).toBe(false);
    await expect(
      store.bind({
        missionIdentifier: "mission-1",
        sequenceIdentifier: "seq-1",
        ownerAgentInstanceIdentifier: "scheduler:mission-1",
        missionTaskIdentifier: "T-01",
        sequenceTaskIdentifier: "node-b",
      }),
    ).rejects.toThrow();
    const listed = await store.listForMission({
      missionIdentifier: "mission-1",
      sequenceIdentifier: "seq-1",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sequenceTaskIdentifier).toBe("node-a");
  });
});

describe("按显式映射生成写回提案", () => {
  function buildBridgeWithMapping() {
    return new TaskLedgerBridge({
      sequenceLedger: {
        getSnapshot: async () => ({
          sequenceId: "seq-1",
          revision: 2,
          nodes: [
            { taskId: "node-a", status: "pending" },
            { taskId: "node-b", status: "pending" },
          ],
          readyTaskIds: [],
        }),
      },
      missionTaskChain: {
        getMissionStatus: async () => ({
          taskChain: {
            tasks: [
              { id: "T-01", status: "done" },
              { id: "T-02", status: "pending" },
            ],
          },
        }),
      },
      taskMappings: {
        listForMission: async () => [
          { missionTaskIdentifier: "T-01", sequenceTaskIdentifier: "node-a" },
          { missionTaskIdentifier: "T-02", sequenceTaskIdentifier: "node-b" },
        ],
      },
    });
  }

  it("只对已完成的映射对生成 mark-sequence-done", async () => {
    const proposal = await buildBridgeWithMapping().buildWriteBackProposal({
      missionIdentifier: "mission-1",
      ownerAgentInstanceId: "scheduler:mission-1",
      sequenceId: "seq-1",
      viewer: { sourceKind: "user", actorId: "user-local" },
    });
    expect(proposal.entries).toHaveLength(1);
    expect(proposal.entries[0]?.taskIdentifier).toBe("node-a");
    expect(proposal.entries[0]?.proposedAction).toBe("mark-sequence-done");
    expect(proposal.notes.join("；")).toContain("显式任务映射");
  });
});
