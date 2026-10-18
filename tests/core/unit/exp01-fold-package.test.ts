/**
 * FOLD-01-02 的反例（2026-10-19 R21）：候选 → 组合包 → 独立验证 → 注册。
 *
 * 卡内验收：两种不同输入 + 反例、不同 Agent 独立验收、覆盖分支差异/部分失败、
 * 权限按展开后每步检查、同版本幂等/异内容冲突。
 */
import { describe, expect, it } from "vitest";

import { registerFoldPackage } from "../../../packages/core/src/orchestration/workflow-fold-package.js";
import {
  assessFoldCandidate,
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
    inputsDescription: "源码与模板",
    outputsDescription: "更新后的发布说明",
    parameters: [
      { parameterName: "outputPath", effectKind: "target", schemaJson: '{"type":"string"}' },
    ],
    preconditions: ["项目根已登记"],
    failureRecoveryDescription: "写失败回滚备份",
    acceptanceMethodDescription: "diff 复核",
    nonApplicableBoundaries: ["跨项目写入"],
    ...overrides,
  };
}

const accepted = assessFoldCandidate(candidate());

function verification(overrides: Partial<Parameters<typeof registerFoldPackage>[0]["verification"]> = {}) {
  return {
    verifierAgentInstanceId: "agent-verifier",
    cases: [
      {
        caseIdentifier: "case-1",
        inputFingerprint: "input-a",
        outcomeKind: "passed" as const,
        coversBranchDifference: false,
        exceedsPreconditions: false,
      },
      {
        caseIdentifier: "case-2",
        inputFingerprint: "input-b",
        outcomeKind: "failed" as const,
        coversBranchDifference: true,
        exceedsPreconditions: true,
      },
    ],
    isEvidenceBacked: true,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    authorAgentInstanceId: "agent-author",
    toolIdentifier: "release-notes-tool",
    version: 1,
    candidateAssessment: accepted,
    verification: verification(),
    expandedStepPermissions: ["read-file", "write-project-file"],
    previouslyApprovedStepPermissions: ["read-file", "write-project-file"],
    existingPackages: [],
    ...overrides,
  };
}

describe("FOLD-01-02：组合包登记与独立验证", () => {
  it("① 完整输入 + 独立验证 ⇒ 登记成功并给出包指纹", () => {
    const outcome = registerFoldPackage(baseInput());
    expect(outcome.kind).toBe("registered");
    if (outcome.kind !== "registered") throw new Error("应登记");
    expect(outcome.bundleFingerprint).toHaveLength(64);
  });

  it("② 作者自己验收 ⇒ 拒绝（实现者不得验收自己的产出）", () => {
    expect(
      registerFoldPackage(
        baseInput({ verification: verification({ verifierAgentInstanceId: "agent-author" }) }),
      ),
    ).toMatchObject({ kind: "rejected", reasonCode: "author-verified-own-work" });
  });

  it("③ 少于两种不同输入 ⇒ 拒绝（单例成功不能证明等价）", () => {
    const singleInput = verification({
      cases: [
        {
          caseIdentifier: "only",
          inputFingerprint: "same",
          outcomeKind: "passed",
          coversBranchDifference: true,
          exceedsPreconditions: false,
        },
        {
          caseIdentifier: "only-2",
          inputFingerprint: "same",
          outcomeKind: "passed",
          coversBranchDifference: true,
          exceedsPreconditions: false,
        },
      ],
    });
    expect(registerFoldPackage(baseInput({ verification: singleInput }))).toMatchObject({
      kind: "rejected",
      reasonCode: "insufficient-inputs",
    });
  });

  it("④ 没有分支差异/部分失败反例 ⇒ 拒绝", () => {
    const noBranch = verification({
      cases: verification().cases.map((testCase) => ({
        ...testCase,
        coversBranchDifference: false,
      })),
    });
    expect(registerFoldPackage(baseInput({ verification: noBranch }))).toMatchObject({
      kind: "rejected",
      reasonCode: "no-counterexample-coverage",
    });
  });

  it("⑤ 验证不是证据驱动 ⇒ 拒绝", () => {
    expect(
      registerFoldPackage(baseInput({ verification: verification({ isEvidenceBacked: false }) })),
    ).toMatchObject({ kind: "rejected", reasonCode: "not-evidence-backed" });
  });

  it("⑥ 展开后的步骤权限超出原批准集合 ⇒ 拒绝（不能借折叠扩权）", () => {
    expect(
      registerFoldPackage(
        baseInput({ expandedStepPermissions: ["read-file", "write-project-file", "install-package"] }),
      ),
    ).toMatchObject({ kind: "rejected", reasonCode: "unregistered-permission-widening" });
  });

  it("⑦ 候选未通过 FOLD-01-01 ⇒ 拒绝；缺标识/版本 ⇒ 拒绝", () => {
    const rejectedCandidate = assessFoldCandidate(candidate({ preconditions: [] }));
    expect(
      registerFoldPackage(baseInput({ candidateAssessment: rejectedCandidate })),
    ).toMatchObject({ kind: "rejected", reasonCode: "candidate-not-accepted" });
    expect(registerFoldPackage(baseInput({ toolIdentifier: " " }))).toMatchObject({
      kind: "rejected",
      reasonCode: "missing-version-or-identifier",
    });
    expect(registerFoldPackage(baseInput({ version: 0 }))).toMatchObject({
      kind: "rejected",
      reasonCode: "missing-version-or-identifier",
    });
  });

  it("⑧ 幂等与冲突：同版本同内容 ⇒ 幂等重放；同版本异内容 ⇒ 冲突", () => {
    const first = registerFoldPackage(baseInput());
    if (first.kind !== "registered") throw new Error("应登记");
    const replay = registerFoldPackage(
      baseInput({
        existingPackages: [
          {
            toolIdentifier: first.toolIdentifier,
            version: first.version,
            bundleFingerprint: first.bundleFingerprint,
          },
        ],
      }),
    );
    expect(replay.kind).toBe("registered");
    if (replay.kind !== "registered") throw new Error("应幂等");
    expect(replay.reason).toContain("幂等");

    const conflict = registerFoldPackage(
      baseInput({
        existingPackages: [
          {
            toolIdentifier: first.toolIdentifier,
            version: first.version,
            bundleFingerprint: "different-fingerprint",
          },
        ],
      }),
    );
    expect(conflict).toMatchObject({ kind: "rejected", reasonCode: "version-conflict" });
  });

  it("⑨ 内容变化会改变包指纹（参数/前置条件变化 ⇒ 新指纹）", () => {
    const first = registerFoldPackage(baseInput());
    if (first.kind !== "registered") throw new Error("应登记");
    const changedCandidate = assessFoldCandidate(candidate({ preconditions: ["项目根已登记", "目标文件存在"] }));
    const changed = registerFoldPackage(baseInput({ version: 2, candidateAssessment: changedCandidate }));
    if (changed.kind !== "registered") throw new Error("应登记");
    expect(changed.bundleFingerprint).not.toBe(first.bundleFingerprint);
  });
});
