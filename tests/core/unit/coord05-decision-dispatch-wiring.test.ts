/**
 * COORD-05 05-05 接线（2026-11-22）：写回后通知运行中的调度器。
 *
 * 覆盖：applyUserDecision 在写回成功时调用一次通知（重复答复不再通知）；
 * MissionOrchestrator/MainController 的登记委托（只登记，不派发）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import { DecisionSubmissionStore } from "../../../packages/core/src/orchestration/decision-submission.js";
import { DecisionWritebackStore } from "../../../packages/core/src/orchestration/decision-writeback.js";
import { applyUserDecision } from "../../../packages/core/src/orchestration/decision-application.js";
import { MissionOrchestrator } from "../../../packages/core/src/orchestration/mission-orchestrator.js";
import { MainController } from "../../../packages/core/src/orchestration/main-controller.js";

const missionId = "m-1";
const nowIso = "2026-11-22T00:00:00.000Z";

let baseDirectory: string;
let taskStore: TaskStore;
let submissionStore: DecisionSubmissionStore;
let writebackStore: DecisionWritebackStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-hook-"));
  taskStore = new TaskStore({ baseDirectory });
  submissionStore = new DecisionSubmissionStore({ baseDirectory });
  writebackStore = new DecisionWritebackStore({ baseDirectory });
  await taskStore.writeTaskChain(chain());
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
    ],
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

describe("COORD-05：写回后通知调度器", () => {
  it("① 写回成功 ⇒ 通知一次；重复答复不再通知", async () => {
    const onDecisionApplied = vi.fn(async () => undefined);
    const deps = {
      submissionStore,
      writebackStore,
      taskStore,
      advanceStep: async () => undefined,
      onDecisionApplied,
      nowIso: () => "2026-11-22T00:05:00.000Z",
    };
    const first = await applyUserDecision(deps, input);
    expect(first.kind).toBe("applied");
    expect(onDecisionApplied).toHaveBeenCalledTimes(1);
    expect(onDecisionApplied).toHaveBeenCalledWith({
      missionIdentifier: missionId,
      decisionIdentifier: "decision-1",
    });

    const second = await applyUserDecision(deps, input);
    expect(second.kind).toBe("duplicate");
    expect(onDecisionApplied).toHaveBeenCalledTimes(1);
  });

  it("② MissionOrchestrator.markDecisionApplied 委托给 DagScheduler", () => {
    const orchestrator = Object.create(MissionOrchestrator.prototype) as MissionOrchestrator;
    const markDecisionApplied = vi.fn();
    (orchestrator as unknown as { dagScheduler: unknown }).dagScheduler = {
      markDecisionApplied,
    };
    orchestrator.markDecisionApplied("decision-1");
    expect(markDecisionApplied).toHaveBeenCalledWith("decision-1");
  });

  it("③ MainController 只对运行中的 mission 登记；无活动编排器返回 false", () => {
    const controller = Object.create(MainController.prototype) as MainController;
    const markDecisionApplied = vi.fn();
    const activeOrchestrators = new Map<string, unknown>([
      [missionId, { scheduler: { markDecisionApplied }, mode: "assist" }],
    ]);
    (controller as unknown as { activeOrchestrators: unknown }).activeOrchestrators =
      activeOrchestrators;

    expect(
      controller.markDecisionAppliedForMission({
        missionIdentifier: missionId,
        decisionIdentifier: "decision-1",
      }),
    ).toBe(true);
    expect(markDecisionApplied).toHaveBeenCalledWith("decision-1");

    expect(
      controller.markDecisionAppliedForMission({
        missionIdentifier: "other-mission",
        decisionIdentifier: "decision-1",
      }),
    ).toBe(false);
  });
});
