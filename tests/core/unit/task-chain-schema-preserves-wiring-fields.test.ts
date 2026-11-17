/**
 * WIRING-04 回归（2026-11-18）：**zod 默认会丢弃未知字段**。
 *
 * 证据（`coordinationApplicationEvidence`）与来源字段（`sourceSequence*`）若未登记进 schema，
 * `createMission` / 任何经过 `taskChainSchema` 的读写都会把它们**静默丢掉**——
 * 那会让"同一次原子写"和"精确映射"在真实链路里失效，而单测（假 store）却全绿。
 */
import { describe, expect, it } from "vitest";

import { taskChainSchema } from "../../../packages/core/src/core/schemas.js";

const baseChain = {
  schemaVersion: 1,
  missionId: "mission-1",
  revision: 2,
  updatedAtIso: "2026-11-18T00:00:00.000Z",
  tasks: [
    {
      id: "T-001",
      description: "执行",
      dependsOn: [],
      taskType: "data",
      toolNames: [],
      assignedAgentId: null,
      status: "running",
      resultLocation: null,
    },
  ],
};

describe("任务链 schema 必须保留证据与来源字段", () => {
  it("① 应用证据经 schema 后仍在（不被丢弃）", () => {
    const parsed = taskChainSchema.safeParse({
      ...baseChain,
      coordinationApplicationEvidence: [
        {
          messageIdentifier: "message-1",
          appliedAtIso: "2026-11-18T00:00:00.000Z",
          resultingTaskStatus: "done",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.coordinationApplicationEvidence).toHaveLength(1);
  }, 30_000);

  it("② 节点的来源字段经 schema 后仍在", () => {
    const parsed = taskChainSchema.safeParse({
      ...baseChain,
      tasks: [
        {
          ...baseChain.tasks[0],
          sourceSequenceTaskIdentifier: "seq-task-7",
          sourceSequenceIdentifier: "sequence-1",
          sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.tasks[0]).toMatchObject({
      sourceSequenceTaskIdentifier: "seq-task-7",
      sourceSequenceIdentifier: "sequence-1",
      sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
    });
  }, 30_000);

  it("③ 非法状态值被拒绝（不是静默接受）", () => {
    const parsed = taskChainSchema.safeParse({
      ...baseChain,
      coordinationApplicationEvidence: [
        {
          messageIdentifier: "message-1",
          appliedAtIso: "2026-11-18T00:00:00.000Z",
          resultingTaskStatus: "running",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  }, 30_000);
});
