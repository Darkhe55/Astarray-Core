/**
 * ALIGN-02-05（2026-11-05）：真实派发端口映射。
 */
import { describe, expect, it } from "vitest";

import { createMissionDispatchPorts } from "../../../packages/core/src/orchestration/secondary-continuous-dispatch-loop.js";

describe("mission 派发端口", () => {
  it("任一 taskId 被编排器接受即返回 true；全部拒绝返回 false", async () => {
    const accepted = createMissionDispatchPorts({
      dispatchTaskByTaskIdentifier: () => ({ outcome: "accepted" }),
    });
    expect(
      await accepted.dispatchChain({
        taskIds: ["T-1"],
        priorityTier: 0,
        agentInstanceId: "agent-1",
      }),
    ).toBe(true);

    const refused = createMissionDispatchPorts({
      dispatchTaskByTaskIdentifier: () => ({ outcome: "refused" }),
    });
    expect(
      await refused.dispatchChain({
        taskIds: ["T-1", "T-2"],
        priorityTier: 0,
        agentInstanceId: "agent-2",
      }),
    ).toBe(false);

    const mixed = createMissionDispatchPorts({
      dispatchTaskByTaskIdentifier: (taskId) => ({
        outcome: taskId === "T-2" ? "accepted" : "refused",
      }),
    });
    expect(
      await mixed.dispatchChain({
        taskIds: ["T-1", "T-2"],
        priorityTier: 0,
        agentInstanceId: "agent-3",
      }),
    ).toBe(true);
  });
});
