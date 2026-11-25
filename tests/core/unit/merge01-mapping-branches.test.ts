/**
 * B9（2026-11-25）：MERGE-01 执行组映射/合并开关分支补充。
 *
 * 只测本地确定性判定与持久化：不联网、不调模型。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createInstructionMergeController,
  type InstructionMergeCandidate,
  type OriginalInstructionRecord,
} from "../../../packages/core/src/toolkit/instruction-merge-mapping.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function instruction(overrides: Partial<OriginalInstructionRecord> = {}): OriginalInstructionRecord {
  return {
    instructionIdentifier: "I-1",
    instructionText: "原始指令一",
    sourceKind: "user",
    sourceActorIdentifier: "user-1",
    revision: 1,
    priorityTier: 0,
    cancellationRightHolderIdentifier: "user-1",
    acceptanceCriteria: ["验收条件"],
    isCompleted: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<InstructionMergeCandidate> = {}): InstructionMergeCandidate {
  return {
    instructionIdentifier: "I-1",
    revision: 1,
    instructionText: "原始指令一",
    projectIdentifier: "project-1",
    taskAuthorityIdentifier: "authority-1",
    permissionScopeIdentifier: "scope-1",
    goalIdentifier: "goal-1",
    priorityTier: 0,
    supersedesInstructionIdentifiers: [],
    dependencyNodeIdentifiers: [],
    completedDependencyNodeIdentifiers: [],
    isSemanticallyConflicting: false,
    isGoalAmbiguous: false,
    requiresIndependentAuthorization: false,
    hasSideEffectInFlight: false,
    ...overrides,
  };
}

describe("B9：MERGE-01 执行组与合并开关", () => {
  it("① 合并开关关闭 ⇒ 不建组，但记录候选关联", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: false,
      windowCapacity: 10,
    });
    controller.appendInstruction(instruction());
    const result = controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [candidate()],
    });
    expect(result.isCreated).toBe(false);
    expect(controller.countExecutionGroups()).toBe(0);
    expect(controller.listCandidateAssociations()).toEqual([{ instructionIdentifier: "I-1", revision: 1 }]);
  });

  it("② 缺资格候选 ⇒ fail-closed 拒绝", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 10,
    });
    controller.appendInstruction(instruction());
    const result = controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1"],
      createdByAgentInstanceId: "agent-1",
    });
    expect(result.isCreated).toBe(false);
    expect(result.reason).toContain("资格");
  });

  it("③ 建组成功：映射绑定 revision/指纹；原指令升版本后引用失效", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 10,
    });
    controller.appendInstruction(instruction());
    const result = controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [candidate()],
    });
    expect(result.isCreated).toBe(true);
    const mapping = controller.describeGroupMapping({ groupIdentifier: "G-1" });
    expect(mapping).toHaveLength(1);
    expect(mapping[0]?.revision).toBe(1);
    expect(mapping[0]?.contentFingerprint).toMatch(/^sha256:/u);
    expect(controller.isGroupReferenceStillValid({ groupIdentifier: "G-1" })).toMatchObject({
      isValid: true,
    });

    controller.appendInstruction(instruction({ revision: 2, instructionText: "原始指令一（修订）" }));
    expect(controller.isGroupReferenceStillValid({ groupIdentifier: "G-1" })).toMatchObject({
      isValid: false,
    });
  });

  it("④ 组派生物恒为 group-derivative 且不覆盖原文", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 10,
    });
    controller.appendInstruction(instruction());
    controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [candidate()],
    });
    const derived = controller.createDerivedWorkItem({
      groupIdentifier: "G-1",
      derivedText: "合并后的执行文本",
      producedByAgentInstanceId: "agent-2",
    });
    expect(derived.sourceKind).toBe("group-derivative");
    expect(derived.isOriginalInstructionTextOverridden).toBe(false);
    expect(derived.originatingInstructionIdentifiers).toContain("I-1");
  });

  it("⑤ 逐成员结算：部分失败不影响其他成员；非取消权持有者不能取消", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 10,
    });
    controller.appendInstruction(instruction());
    controller.appendInstruction(
      instruction({ instructionIdentifier: "I-2", instructionText: "原始指令二" }),
    );
    controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1", "I-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [
        candidate(),
        candidate({ instructionIdentifier: "I-2", instructionText: "原始指令二" }),
      ],
    });

    const settled = controller.settleGroupMember({
      groupIdentifier: "G-1",
      instructionIdentifier: "I-1",
      outcome: "failed",
      reason: "失败原因",
    });
    expect(settled.isSettled).toBe(true);
    const settlements = controller.describeGroupMemberSettlements({ groupIdentifier: "G-1" });
    expect(settlements.find((entry) => entry.instructionIdentifier === "I-1")).toMatchObject({
      outcome: "failed",
    });
    expect(settlements.find((entry) => entry.instructionIdentifier === "I-2")).toMatchObject({
      outcome: "pending",
    });

    const rejected = controller.cancelGroupMember({
      groupIdentifier: "G-1",
      instructionIdentifier: "I-2",
      cancelledByAgentInstanceId: "agent-9",
      reason: "越权取消",
    });
    expect(rejected.isCancelled).toBe(false);

    const cancelled = controller.cancelGroupMember({
      groupIdentifier: "G-1",
      instructionIdentifier: "I-2",
      cancelledByAgentInstanceId: "user-1",
      reason: "用户取消",
    });
    expect(cancelled.isCancelled).toBe(true);
    expect(controller.describeGroupMemberSettlements({ groupIdentifier: "G-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instructionIdentifier: "I-1", outcome: "failed" }),
        expect.objectContaining({ instructionIdentifier: "I-2", outcome: "cancelled" }),
      ]),
    );
  });

  it("⑥ 完成核验：门禁拒绝 ⇒ 不完成；接受 ⇒ 完成", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: false,
      windowCapacity: 10,
    });
    controller.appendInstruction(instruction());
    expect(
      controller.verifyInstructionCompletion({
        instructionIdentifier: "I-1",
        verifiedByGateIdentifier: "gate-1",
        isAccepted: false,
      }).isCompleted,
    ).toBe(false);
    expect(controller.isInstructionCompleted("I-1")).toBe(false);
    expect(
      controller.verifyInstructionCompletion({
        instructionIdentifier: "I-1",
        verifiedByGateIdentifier: "gate-1",
        isAccepted: true,
      }).isCompleted,
    ).toBe(true);
    expect(controller.isInstructionCompleted("I-1")).toBe(true);
  });

  it("⑦ 未完成原指令计数与窗口容量（组完成不自动关闭原指令）", () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 1,
    });
    controller.appendInstruction(instruction());
    controller.appendInstruction(
      instruction({ instructionIdentifier: "I-2", instructionText: "原始指令二" }),
    );
    expect(controller.countUnfinishedOriginalIntentions()).toBe(2);
    expect(controller.isWindowCapacityExceeded()).toBe(true);

    controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [candidate()],
    });
    controller.markGroupCompleted({ groupIdentifier: "G-1" });
    expect(controller.countUnfinishedOriginalIntentions()).toBe(2);
  });

  it("⑧ 落盘/恢复往返：原指令、组映射与成员结算都恢复", async () => {
    const controller = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 10,
      stateDirectory,
    });
    controller.appendInstruction(instruction());
    controller.createExecutionGroup({
      groupIdentifier: "G-1",
      referencedInstructionIdentifiers: ["I-1"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [candidate()],
    });
    controller.settleGroupMember({
      groupIdentifier: "G-1",
      instructionIdentifier: "I-1",
      outcome: "succeeded",
      reason: null,
    });
    expect(await controller.persistToDisk()).toMatchObject({ isPersisted: true });

    const restored = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 10,
      stateDirectory,
    });
    const restore = await restored.restoreFromDisk();
    expect(restore.isRestored).toBe(true);
    expect(restored.countExecutionGroups()).toBe(1);
    expect(restored.describeGroupMapping({ groupIdentifier: "G-1" })).toHaveLength(1);
    expect(restored.describeGroupMemberSettlements({ groupIdentifier: "G-1" })[0]).toMatchObject({
      outcome: "succeeded",
    });
    expect(restored.isInstructionCompleted("I-1")).toBe(false);
  });
});
