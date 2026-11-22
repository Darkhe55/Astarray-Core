/**
 * COORD-05（2026-11-22）：门面 `applyUserDecision` 入口。
 *
 * 从公开门面完成"用户答复 → 决定写回任务链"，并验证重复答复幂等。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { DecisionSubmissionStore } from "../../../packages/core/src/orchestration/decision-submission.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;
let stateDirectory: string;
const missionId = "m-1";
const nowIso = "2026-11-22T00:00:00.000Z";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-facade-"));
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
    ],
  };
}

async function seed(): Promise<void> {
  const taskStore = new TaskStore({ baseDirectory: stateDirectory });
  await taskStore.writeTaskChain(chain());
  const submissionStore = new DecisionSubmissionStore({ baseDirectory: stateDirectory });
  await submissionStore.upsertPending({
    submissionIdentifier: "escalation-1",
    projectIdentifier: "p1",
    decisionId: "decision-1",
    summary: "采用方案 A",
    recommendedReason: null,
    affectedStepIdentifiers: ["step-export"],
    candidates: [],
    state: "pending-record",
    channel: null,
    receiptIdentifier: null,
    createdAtIso: nowIso,
    submittedAtIso: null,
    answeredAtIso: null,
    answer: null,
  });
  await submissionStore.markSubmitted({
    submissionIdentifier: "escalation-1",
    channel: "direct-user",
    receiptIdentifier: "receipt-1",
    submittedAtIso: nowIso,
  });
}

describe("COORD-05：门面用户答复入口", () => {
  it("① 答复 ⇒ 写回任务链；重复答复幂等", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      await seed();
      const first = await application.applyUserDecision({
        submissionIdentifier: "escalation-1",
        projectIdentifier: "p1",
        answer: "a",
        missionIdentifier: missionId,
        taskIdentifier: "T-1",
        answeredAtIso: "2026-11-22T00:04:00.000Z",
      });
      expect(first.kind).toBe("applied");
      const persisted = await new TaskStore({ baseDirectory: stateDirectory }).readTaskChain(missionId);
      expect(persisted?.decisionApplicationEvidence?.[0]?.decisionIdentifier).toBe("decision-1");

      const second = await application.applyUserDecision({
        submissionIdentifier: "escalation-1",
        projectIdentifier: "p1",
        answer: "a",
        missionIdentifier: missionId,
        taskIdentifier: "T-1",
      });
      expect(second.kind).toBe("duplicate");
    } finally {
      await application.shutdown();
    }
  });

  it("② 项目不匹配 ⇒ 拒绝", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      await seed();
      const outcome = await application.applyUserDecision({
        submissionIdentifier: "escalation-1",
        projectIdentifier: "p2",
        answer: "a",
        missionIdentifier: missionId,
        taskIdentifier: "T-1",
      });
      expect(outcome).toMatchObject({ kind: "refused", code: "project-mismatch" });
    } finally {
      await application.shutdown();
    }
  });
});
