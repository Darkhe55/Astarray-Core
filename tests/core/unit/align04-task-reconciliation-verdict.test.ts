/**
 * ALIGN-04-03（2026-11-10）：**任务级对账结论**。
 *
 * 卡内缺口："不会把 running/blocked/已产出任务放回 pending 或**记录对账结论**"。
 *
 * 本文件钉住"结论"这一侧：每个未完成任务该做什么，以及**不得**自动改状态。
 */
import { describe, expect, it, vi } from "vitest";

import {
  hasReconciliationBlockingVerdict,
  projectTaskReconciliationVerdicts,
} from "../../../packages/core/src/orchestration/task-reconciliation-verdict.js";
import type { TaskChainDocument, TaskDependencyNode } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 30_000 });

function buildNode(
  id: string,
  status: TaskDependencyNode["status"],
  resultLocation: string | null = null,
): TaskDependencyNode {
  return {
    id,
    description: "任务 " + id,
    dependsOn: [],
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status,
    resultLocation,
  };
}

function buildChain(nodes: TaskDependencyNode[]): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "mission-reconcile",
    revision: 1,
    updatedAtIso: "2026-11-10T00:00:00.000Z",
    tasks: nodes,
  };
}

describe("ALIGN-04-03 任务级对账结论", () => {
  it("四类任务各自得到明确结论", () => {
    const verdicts = projectTaskReconciliationVerdicts(
      buildChain([
        buildNode("T-done", "done"),
        buildNode("T-pending", "pending"),
        buildNode("T-running", "running"),
        buildNode("T-blocked", "blocked"),
        buildNode("T-produced", "pending", "docs/out.md"),
      ]),
    );
    const byId = new Map(verdicts.map((verdict) => [verdict.taskIdentifier, verdict.action]));
    expect(byId.get("T-done")).toBe("none");
    expect(byId.get("T-pending")).toBe("resumable");
    expect(byId.get("T-running")).toBe("requires-side-effect-review");
    expect(byId.get("T-blocked")).toBe("requires-decision");
    expect(byId.get("T-produced")).toBe("requires-output-acknowledgement");
  });

  it("**running 不得被当作可重跑**（副作用未知）", () => {
    const verdicts = projectTaskReconciliationVerdicts(buildChain([buildNode("T-1", "running")]));
    expect(verdicts[0]?.action).not.toBe("resumable");
    expect(verdicts[0]?.reason).toContain("副作用未知");
  });

  it("已产出但未回执 ⇒ 先确认产出（不直接重跑）", () => {
    const verdicts = projectTaskReconciliationVerdicts(
      buildChain([buildNode("T-1", "pending", "docs/out.md")]),
    );
    expect(verdicts[0]?.action).toBe("requires-output-acknowledgement");
    expect(verdicts[0]?.reason).toContain("docs/out.md");
  });

  it("空 resultLocation 的 pending 仍视为可恢复（不被误判为已产出）", () => {
    const verdicts = projectTaskReconciliationVerdicts(
      buildChain([buildNode("T-1", "pending", "   ")]),
    );
    expect(verdicts[0]?.action).toBe("resumable");
  });

  it("阻塞判定：只有 done/pending 时不阻塞", () => {
    expect(
      hasReconciliationBlockingVerdict(
        projectTaskReconciliationVerdicts(
          buildChain([buildNode("T-1", "done"), buildNode("T-2", "pending")]),
        ),
      ),
    ).toBe(false);
  });

  it("阻塞判定：出现 running/blocked/已产出时阻塞", () => {
    for (const node of [
      buildNode("T-1", "running"),
      buildNode("T-2", "blocked"),
      buildNode("T-3", "pending", "docs/out.md"),
    ]) {
      expect(
        hasReconciliationBlockingVerdict(projectTaskReconciliationVerdicts(buildChain([node]))),
      ).toBe(true);
    }
  });

  it("每条结论都带非空原因（可读诊断）", () => {
    const verdicts = projectTaskReconciliationVerdicts(
      buildChain([buildNode("T-1", "running"), buildNode("T-2", "pending")]),
    );
    for (const verdict of verdicts) {
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });
});
