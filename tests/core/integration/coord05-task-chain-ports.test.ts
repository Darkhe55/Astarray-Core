/**
 * COORD-05 05-05 接线（2026-11-22）：任务链端口适配器。
 *
 * 覆盖：任务链 revision、决定证据追加（幂等/冲突）、等待步骤映射、推进回调，
 * 以及与 05-05 写回流程的真实串联（记录回答 → 写回任务链 → 只推进依赖步骤）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import { createTaskChainDecisionPorts } from "../../../packages/core/src/orchestration/task-chain-decision-ports.js";
import {
  DecisionWritebackStore,
  applyDecisionWriteback,
} from "../../../packages/core/src/orchestration/decision-writeback.js";

let baseDirectory: string;
let taskStore: TaskStore;
const missionId = "m-1";
const nowIso = "2026-11-22T00:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-ports-"));
  taskStore = new TaskStore({ baseDirectory });
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

describe("COORD-05：任务链决定端口", () => {
  it("① 读状态：显式依赖决定的等待步骤 → waiting-on-decision", async () => {
    const ports = createTaskChainDecisionPorts({
      store: taskStore,
      missionIdentifier: missionId,
      advanceStep: async () => undefined,
    });
    const state = await ports.readMissionState(missionId);
    expect(state.status).toBe("running");
    expect(state.steps).toEqual([
      {
        stepIdentifier: "step-export",
        status: "waiting-on-decision",
        dependsOnDecisionIdentifiers: ["decision-1"],
      },
      {
        stepIdentifier: "step-other",
        status: "pending",
        dependsOnDecisionIdentifiers: [],
      },
    ]);
  });

  it("② 写回决定：追加证据并递增 revision；重复写回幂等", async () => {
    const ports = createTaskChainDecisionPorts({
      store: taskStore,
      missionIdentifier: missionId,
      advanceStep: async () => undefined,
    });
    expect(await ports.readDocumentRevision()).toBe(1);
    const first = await ports.writeDecision({
      decisionIdentifier: "decision-1",
      escalationRequestIdentifier: "escalation-1",
      missionIdentifier: missionId,
      taskIdentifier: "T-1",
      source: "user",
      summary: "采用方案 A",
      affectedStepIdentifiers: ["step-export"],
      expectedRevision: null,
    });
    expect(first.documentRevision).toBe(2);

    const persisted = await taskStore.readTaskChain(missionId);
    expect(persisted?.decisionApplicationEvidence).toEqual([
      {
        decisionIdentifier: "decision-1",
        escalationRequestIdentifier: "escalation-1",
        source: "user",
        summary: "采用方案 A",
        affectedStepIdentifiers: ["step-export"],
        appliedAtIso: expect.any(String),
      },
    ]);

    const second = await ports.writeDecision({
      decisionIdentifier: "decision-1",
      escalationRequestIdentifier: "escalation-1",
      missionIdentifier: missionId,
      taskIdentifier: "T-1",
      source: "user",
      summary: "采用方案 A",
      affectedStepIdentifiers: ["step-export"],
      expectedRevision: null,
    });
    expect(second.documentRevision).toBe(2);
    expect((await taskStore.readTaskChain(missionId))?.revision).toBe(2);
  });

  it("③ 期望 revision 不一致 ⇒ 拒绝写回（不覆盖并发更新）", async () => {
    const ports = createTaskChainDecisionPorts({
      store: taskStore,
      missionIdentifier: missionId,
      advanceStep: async () => undefined,
    });
    await expect(
      ports.writeDecision({
        decisionIdentifier: "decision-1",
        escalationRequestIdentifier: "escalation-1",
        missionIdentifier: missionId,
        taskIdentifier: "T-1",
        source: "agent",
        summary: "x",
        affectedStepIdentifiers: [],
        expectedRevision: 7,
      }),
    ).rejects.toThrow(/revision 已变化/);
  });

  it("④ advanceStep 委托给调度器回调", async () => {
    const advanced: string[] = [];
    const ports = createTaskChainDecisionPorts({
      store: taskStore,
      missionIdentifier: missionId,
      advanceStep: async (stepIdentifier) => {
        advanced.push(stepIdentifier);
      },
    });
    await ports.advanceStep("step-export");
    expect(advanced).toEqual(["step-export"]);
  });

  it("⑤ mission 不存在 ⇒ 状态 unknown；写回拒绝", async () => {
    const ports = createTaskChainDecisionPorts({
      store: taskStore,
      missionIdentifier: "missing-mission",
      advanceStep: async () => undefined,
    });
    expect(await ports.readMissionState("missing-mission")).toEqual({
      status: "unknown",
      steps: [],
    });
    await expect(ports.readDocumentRevision()).rejects.toThrow(/任务链不存在/);
  });

  it("⑥ 与 05-05 写回串联：记录回答 → 写回任务链 → 只推进依赖步骤", async () => {
    const writebackStore = new DecisionWritebackStore({ baseDirectory });
    await writebackStore.recordAnswer({
      decisionIdentifier: "decision-1",
      escalationRequestIdentifier: "escalation-1",
      projectIdentifier: "p1",
      missionIdentifier: missionId,
      taskIdentifier: "T-1",
      source: "user",
      summary: "采用方案 A",
      affectedStepIdentifiers: ["step-export"],
      status: "answered",
      documentRevision: null,
      advancedStepIdentifiers: [],
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    });
    const advanced: string[] = [];
    const ports = createTaskChainDecisionPorts({
      store: taskStore,
      missionIdentifier: missionId,
      advanceStep: async (stepIdentifier) => {
        advanced.push(stepIdentifier);
      },
    });
    const outcome = await applyDecisionWriteback(
      { store: writebackStore, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:01:00.000Z" },
    );
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.advancedSteps).toEqual(["step-export"]);
    expect(advanced).toEqual(["step-export"]);
    const persisted = await taskStore.readTaskChain(missionId);
    expect(persisted?.decisionApplicationEvidence?.[0]?.decisionIdentifier).toBe("decision-1");
  });
});
