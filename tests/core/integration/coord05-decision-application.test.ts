/**
 * COORD-05 05-04×05-05 接线（2026-11-22）：用户答复 → 决定写回 → 任务链。
 *
 * 覆盖：happy path、重复答复幂等、项目不匹配、未呈交不可答复、mission 取消不重启、
 * 任务链缺失时写回 deferred（不谎报成功）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import { DecisionSubmissionStore } from "../../../packages/core/src/orchestration/decision-submission.js";
import { DecisionWritebackStore } from "../../../packages/core/src/orchestration/decision-writeback.js";
import { applyUserDecision } from "../../../packages/core/src/orchestration/decision-application.js";

const missionId = "m-1";
const nowIso = "2026-11-22T00:00:00.000Z";

let baseDirectory: string;
let taskStore: TaskStore;
let submissionStore: DecisionSubmissionStore;
let writebackStore: DecisionWritebackStore;
let advanced: string[];

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-apply-"));
  taskStore = new TaskStore({ baseDirectory });
  submissionStore = new DecisionSubmissionStore({ baseDirectory });
  writebackStore = new DecisionWritebackStore({ baseDirectory });
  advanced = [];
  await taskStore.writeTaskChain(chain());
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

async function seedSubmittedSubmission(): Promise<void> {
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

function deps(options: { missionStatus?: "running" | "cancelled" | "completed" | "unknown" } = {}) {
  return {
    submissionStore,
    writebackStore,
    taskStore,
    advanceStep: async (_mission: string, step: string) => {
      advanced.push(step);
    },
    ...(options.missionStatus === undefined
      ? {}
      : { resolveMissionStatus: async () => options.missionStatus! }),
    nowIso: () => "2026-11-22T00:05:00.000Z",
  };
}

const input = {
  submissionIdentifier: "escalation-1",
  projectIdentifier: "p1",
  answer: "a",
  answeredAtIso: "2026-11-22T00:04:00.000Z",
  missionIdentifier: missionId,
  taskIdentifier: "T-1",
} as const;

describe("COORD-05：用户答复 → 写回 → 任务链", () => {
  it("① 答复 ⇒ 写回任务链证据并只推进依赖步骤", async () => {
    await seedSubmittedSubmission();
    const outcome = await applyUserDecision(deps(), input);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.advancedSteps).toEqual(["step-export"]);
    expect(advanced).toEqual(["step-export"]);
    const persisted = await taskStore.readTaskChain(missionId);
    expect(persisted?.decisionApplicationEvidence?.[0]?.decisionIdentifier).toBe("decision-1");
    const submission = (await submissionStore.list())[0];
    expect(submission?.state).toBe("answered");
    expect(submission?.answer).toBe("a");
  });

  it("② 重复答复 ⇒ duplicate，不重复推进", async () => {
    await seedSubmittedSubmission();
    await applyUserDecision(deps(), input);
    const second = await applyUserDecision(deps(), input);
    expect(second.kind).toBe("duplicate");
    if (second.kind !== "duplicate") return;
    expect(second.advancedSteps).toEqual([]);
    expect(advanced).toEqual(["step-export"]);
  });

  it("③ 项目不匹配 ⇒ 拒绝且不写回", async () => {
    await seedSubmittedSubmission();
    const outcome = await applyUserDecision(deps(), { ...input, projectIdentifier: "p2" });
    expect(outcome).toMatchObject({ kind: "refused", code: "project-mismatch" });
    expect(await taskStore.readTaskChain(missionId)).toMatchObject({ revision: 1 });
  });

  it("④ 未呈交 ⇒ 拒绝（不能先答复后呈交）", async () => {
    await submissionStore.upsertPending({
      submissionIdentifier: "escalation-1",
      projectIdentifier: "p1",
      decisionId: "decision-1",
      summary: "采用方案 A",
      recommendedReason: null,
      affectedStepIdentifiers: [],
      candidates: [],
      state: "pending-record",
      channel: null,
      receiptIdentifier: null,
      createdAtIso: nowIso,
      submittedAtIso: null,
      answeredAtIso: null,
      answer: null,
    });
    const outcome = await applyUserDecision(deps(), input);
    expect(outcome).toMatchObject({ kind: "refused", code: "not-submitted" });
  });

  it("⑤ mission 已取消 ⇒ 拒绝且不写回、不推进（迟到答案不重启）", async () => {
    await seedSubmittedSubmission();
    const outcome = await applyUserDecision(deps({ missionStatus: "cancelled" }), input);
    expect(outcome).toMatchObject({ kind: "refused", code: "mission-cancelled" });
    expect(advanced).toEqual([]);
    expect(await taskStore.readTaskChain(missionId)).toMatchObject({ revision: 1 });
  });

  it("⑥ 任务链缺失 ⇒ 写回 deferred（不谎报成功）", async () => {
    await seedSubmittedSubmission();
    const outcome = await applyUserDecision(
      deps(),
      { ...input, missionIdentifier: "missing-mission" },
    );
    expect(outcome).toMatchObject({ kind: "refused", code: "writeback-deferred" });
    expect(advanced).toEqual([]);
  });
});
