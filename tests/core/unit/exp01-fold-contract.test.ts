/**
 * FOLD-01-01 的反例（2026-10-18 R9）：等价折叠的复用契约、候选与版本/权限模型。
 *
 * 卡内验收：等价是**明确前置条件**下的行为契约（不是相似文本）；不可折叠项（授权/结果/回执/
 * 权限裁决/一次性 nonce/批准指纹）不得折进模板；只复用方法、不复用上次许可；
 * 每个实际步骤仍须执行前授权；回退前确认无未知副作用且不自动重跑。
 */
import { describe, expect, it } from "vitest";

import {
  NON_FOLDABLE_ITEMS,
  assessFoldCandidate,
  buildReusableToolRegistration,
  evaluateReusableToolRollback,
  isFoldStepDependencyOrderValid,
  type FoldCandidateInput,
} from "../../../packages/core/src/orchestration/workflow-fold-contract.js";

function candidate(overrides: Partial<FoldCandidateInput> = {}): FoldCandidateInput {
  return {
    originalWorkflowReference: "workflow:release-notes",
    steps: [
      { stepIdentifier: "read", dependsOnStepIdentifiers: [], toolName: "readFile", isFixed: true },
      {
        stepIdentifier: "write",
        dependsOnStepIdentifiers: ["read"],
        toolName: "replaceFileContent",
        isFixed: false,
      },
    ],
    inputsDescription: "项目源码与发布说明模板",
    outputsDescription: "更新后的发布说明文件",
    parameters: [
      { parameterName: "outputPath", effectKind: "target", schemaJson: '{"type":"string"}' },
      { parameterName: "content", effectKind: "content", schemaJson: '{"type":"string"}' },
    ],
    preconditions: ["项目根已登记", "目标文件存在且可写"],
    failureRecoveryDescription: "写失败回滚备份并停止",
    acceptanceMethodDescription: "diff 与人工复核",
    nonApplicableBoundaries: ["跨项目写入", "目标为受保护存储"],
    ...overrides,
  };
}

describe("FOLD-01-01：折叠候选、不可折叠项与版本/权限模型", () => {
  it("① 完整候选 ⇒ accepted，且指纹确定（同内容同指纹、参数 schema 变则变）", () => {
    const accepted = assessFoldCandidate(candidate());
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("应接受");
    expect(accepted.fingerprint).toHaveLength(64);

    const sameAgain = assessFoldCandidate(candidate());
    if (sameAgain.kind !== "accepted") throw new Error("应接受");
    expect(sameAgain.fingerprint).toBe(accepted.fingerprint);

    const changedSchema = assessFoldCandidate(
      candidate({
        parameters: [
          { parameterName: "outputPath", effectKind: "target", schemaJson: '{"type":"number"}' },
        ],
      }),
    );
    if (changedSchema.kind !== "accepted") throw new Error("应接受");
    expect(changedSchema.fingerprint).not.toBe(accepted.fingerprint);
  });

  it("② 缺少前置条件 ⇒ 拒绝（不能用相似文本冒充等价）", () => {
    const rejected = assessFoldCandidate(candidate({ preconditions: [] }));
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("no-preconditions");
  });

  it("③ 缺少不适用边界 ⇒ 拒绝（等价范围未冻结）", () => {
    const rejected = assessFoldCandidate(candidate({ nonApplicableBoundaries: [] }));
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("no-non-applicable-boundary");
  });

  it("④ 不可折叠项（授权/结果/回执/裁决/nonce/批准指纹）被折入 ⇒ 一律拒绝", () => {
    for (const nonFoldableItem of NON_FOLDABLE_ITEMS) {
      const rejected = assessFoldCandidate(
        candidate({ foldedNonFoldableItems: [nonFoldableItem] }),
      );
      expect(rejected.kind).toBe("rejected");
      if (rejected.kind !== "rejected") throw new Error("应拒绝");
      expect(rejected.reasonCode).toBe("folds-non-foldable-item");
    }
  });

  it("⑤ 影响副作用的参数缺名称/schema ⇒ 拒绝（不同内容不能映射成同一授权/幂等身份）", () => {
    const rejected = assessFoldCandidate(
      candidate({
        parameters: [{ parameterName: "  ", effectKind: "content", schemaJson: '{"type":"string"}' }],
      }),
    );
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("unparameterized-side-effect");
  });

  it("⑥ 步骤偏序：缺依赖/自环/成环 ⇒ 非法；合法偏序通过", () => {
    expect(isFoldStepDependencyOrderValid(candidate().steps)).toBe(true);
    expect(
      isFoldStepDependencyOrderValid([
        { stepIdentifier: "a", dependsOnStepIdentifiers: ["missing"], toolName: "x", isFixed: true },
      ]),
    ).toBe(false);
    expect(
      isFoldStepDependencyOrderValid([
        { stepIdentifier: "a", dependsOnStepIdentifiers: ["a"], toolName: "x", isFixed: true },
      ]),
    ).toBe(false);
    expect(
      isFoldStepDependencyOrderValid([
        { stepIdentifier: "a", dependsOnStepIdentifiers: ["b"], toolName: "x", isFixed: true },
        { stepIdentifier: "b", dependsOnStepIdentifiers: ["a"], toolName: "y", isFixed: true },
      ]),
    ).toBe(false);
    const rejected = assessFoldCandidate(
      candidate({
        steps: [
          { stepIdentifier: "a", dependsOnStepIdentifiers: ["b"], toolName: "x", isFixed: true },
          { stepIdentifier: "b", dependsOnStepIdentifiers: ["a"], toolName: "y", isFixed: true },
        ],
      }),
    );
    expect(rejected.kind).toBe("rejected");
  });

  it("⑦ 登记：版本化名称/schema/来源/完整用法齐全 ⇒ registered；且逐步骤授权、不复用旧许可", () => {
    const assessment = assessFoldCandidate(candidate());
    const registered = buildReusableToolRegistration({
      toolIdentifier: "release-notes-tool",
      version: 1,
      parameterSchemaJson: '{"type":"object"}',
      sourceIdentifier: "workflow:release-notes",
      fullPublicUsage: "用法：…（完整公开用法）",
      foldAssessment: assessment,
    });
    expect(registered.kind).toBe("registered");
    if (registered.kind !== "registered") throw new Error("应登记成功");
    expect(registered.registration.requiresPerStepAuthorization).toBe(true);
    expect(registered.registration.reusesPreviousAuthorization).toBe(false);
    expect(registered.registration.registrationFingerprint).toHaveLength(64);

    const missingUsage = buildReusableToolRegistration({
      toolIdentifier: "release-notes-tool",
      version: 1,
      parameterSchemaJson: '{"type":"object"}',
      sourceIdentifier: "workflow:release-notes",
      fullPublicUsage: "  ",
      foldAssessment: assessment,
    });
    expect(missingUsage.kind).toBe("rejected");

    const badVersion = buildReusableToolRegistration({
      toolIdentifier: "release-notes-tool",
      version: 0,
      parameterSchemaJson: '{"type":"object"}',
      sourceIdentifier: "workflow:release-notes",
      fullPublicUsage: "用法",
      foldAssessment: assessment,
    });
    expect(badVersion.kind).toBe("rejected");
  });

  it("⑧ 未通过折叠校验的候选不能登记", () => {
    const rejectedAssessment = assessFoldCandidate(candidate({ preconditions: [] }));
    const registered = buildReusableToolRegistration({
      toolIdentifier: "release-notes-tool",
      version: 1,
      parameterSchemaJson: '{"type":"object"}',
      sourceIdentifier: "workflow:release-notes",
      fullPublicUsage: "用法",
      foldAssessment: rejectedAssessment,
    });
    expect(registered.kind).toBe("rejected");
    if (registered.kind !== "rejected") throw new Error("应拒绝");
    expect(registered.reason).toContain("折叠校验");
  });

  it("⑨ 回退：有未知副作用 ⇒ 拒绝；版本非法 ⇒ 拒绝；正常回退也不自动重跑", () => {
    expect(
      evaluateReusableToolRollback({ currentVersion: 2, targetVersion: 1, hasUnknownSideEffects: true }),
    ).toMatchObject({ isAllowed: false, reasonCode: "unknown-side-effects", doesAutoReplayOldWorkflow: false });

    expect(
      evaluateReusableToolRollback({ currentVersion: 1, targetVersion: 1, hasUnknownSideEffects: false }),
    ).toMatchObject({ isAllowed: false, reasonCode: "invalid-version" });

    const allowed = evaluateReusableToolRollback({
      currentVersion: 3,
      targetVersion: 2,
      hasUnknownSideEffects: false,
    });
    expect(allowed.isAllowed).toBe(true);
    expect(allowed.doesAutoReplayOldWorkflow).toBe(false);
  });
});
