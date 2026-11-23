/**
 * D4（2026-11-23 产品裁决）：执行尝试序号。
 *
 * - 权威派发器在启动 worker 前 +1 并持久化到任务链节点；
 * - worker 从派发记录盖章到反馈信封；
 * - 消费端与当前节点比较；旧信封缺字段 ⇒ 不可验证（不猜测）。
 */
import { describe, expect, it } from "vitest";

import { TaskGraph } from "../../../packages/core/src/core/task-graph.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";

function chain(executionAttempt?: number): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "m-1",
    revision: 1,
    updatedAtIso: "2026-11-23T00:00:00.000Z",
    tasks: [
      {
        id: "T-1",
        description: "任务",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: "w1",
        status: "running",
        resultLocation: null,
        ...(executionAttempt === undefined ? {} : { executionAttempt }),
      },
    ],
  };
}

describe("D4：执行尝试序号", () => {
  it("① 首次派发 ⇒ 1；再次真实执行 ⇒ 递增", () => {
    const graph = new TaskGraph(chain().tasks);
    expect(graph.recordDispatchAttempt("T-1")).toBe(1);
    expect(graph.recordDispatchAttempt("T-1")).toBe(2);
  });

  it("② 旧节点无字段 ⇒ 从 1 开始（不猜测历史尝试）", () => {
    const graph = new TaskGraph(chain().tasks);
    expect(graph.getNode("T-1")?.executionAttempt).toBeUndefined();
    expect(graph.recordDispatchAttempt("T-1")).toBe(1);
  });

  it("③ 存在字段 ⇒ 继续单调递增（重启后从链上继续）", () => {
    const graph = new TaskGraph(chain(7).tasks);
    expect(graph.recordDispatchAttempt("T-1")).toBe(8);
  });

  it("④ 不存在的任务 ⇒ 明确报错（不静默）", () => {
    const graph = new TaskGraph(chain().tasks);
    expect(() => graph.recordDispatchAttempt("T-404")).toThrowError(/任务不存在/);
  });
});
