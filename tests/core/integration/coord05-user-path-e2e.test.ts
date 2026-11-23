/**
 * COORD-05（2026-11-23）：**用户路径端到端**——呈交 → 待决记录 → 答复 → 写回 → 调度放行。
 *
 * 跨模块组合（门面 submitDecisionSummary + 门面 applyUserDecision + TaskStore + TaskGraph），
 * 证明"用户回答后，依赖该决定的步骤真的变得可派发"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { TaskGraph } from "../../../packages/core/src/core/task-graph.js";
import { UserClarificationStore } from "../../../packages/core/src/orchestration/user-clarification.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;
let stateDirectory: string;
const missionId = "m-1";
const nowIso = "2026-11-23T00:00:00.000Z";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-e2e-"));
  stateDirectory = path.join(temporaryDirectory, ".astarray");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function chain(): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId,
    revision: 1,
    updatedAtIso: nowIso,
    tasks: [
      {
        id: "step-export",
        description: "导出",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: "w1",
        status: "pending",
        resultLocation: null,
        dependsOnDecisionIdentifiers: ["decision-1"],
      },
      {
        id: "step-other",
        description: "无关步骤",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: "w1",
        status: "pending",
        resultLocation: null,
      },
    ],
  };
}

describe("COORD-05：用户路径端到端", () => {
  it("呈交 ⇒ 待决记录 ⇒ 答复 ⇒ 写回证据 ⇒ 依赖步骤可派发", async () => {
    const taskStore = new TaskStore({ baseDirectory: stateDirectory });
    await taskStore.writeTaskChain(chain());
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });

      const submitted = await application.submitDecisionSummary({
        submissionIdentifier: "escalation-1",
        projectIdentifier: "p1",
        decisionId: "decision-1",
        ownerAgentInstanceId: "tertiary-1",
        taskIdentifier: "T-1",
        summary: "是否允许导出",
        recommendedReason: "范围内",
        affectedStepIdentifiers: ["step-export"],
        candidates: [{ candidateIdentifier: "c1", label: "允许", value: "yes" }],
        nowIso,
      });
      expect(submitted).toMatchObject({ kind: "submitted", channel: "direct-user" });
      const pending = await new UserClarificationStore({ baseDirectory: stateDirectory }).listPending("p1");
      expect(pending).toHaveLength(1);

      /** 写回前：依赖决定的步骤不可派发。 */
      const before = TaskGraph.fromTaskChain(chain()).findRunnableTaskIds();
      expect(before).not.toContain("step-export");

      const answered = await application.applyUserDecision({
        submissionIdentifier: "escalation-1",
        projectIdentifier: "p1",
        answer: "yes",
        missionIdentifier: missionId,
        taskIdentifier: "T-1",
        answeredAtIso: "2026-11-23T00:05:00.000Z",
      });
      expect(answered.kind).toBe("applied");

      const persisted = await taskStore.readTaskChain(missionId);
      expect(persisted?.decisionApplicationEvidence?.[0]?.decisionIdentifier).toBe("decision-1");

      /** 写回后：同一份任务链 + 应用证据 ⇒ 依赖步骤进入 ready set。 */
      const graph = TaskGraph.fromTaskChain(persisted!);
      graph.markDecisionApplied("decision-1");
      const after = graph.findRunnableTaskIds();
      expect(after).toContain("step-export");
      expect(after).toContain("step-other");
    } finally {
      await application.shutdown();
    }
  });
});
