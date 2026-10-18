/**
 * FOLD-01-02（EXP-01，2026-10-19 R21）：**候选 → 组合包 → 独立验证 → 注册**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §2）：
 * - 「用**至少两种不同输入及反例**比较原流程与候选输出、工具顺序约束和副作用；
 *   **不同 Agent 独立验收**，覆盖**超出前置条件、分支差异及部分失败**」；
 * - 「参数必须包含影响副作用的内容/目标，**防止模板把不同写入内容映射成同一授权或幂等身份**」；
 * - 「复用工具注册**版本化名称、参数 schema、来源和完整公开用法**」；
 * - 「权限按**展开后的每个实际步骤**执行前检查」；升级不能静默改变在途实例；
 * - 「出现回归可以停用新版本，回退前确认没有未知副作用，不自动重跑旧工作流」。
 *
 * ## 边界
 * 纯判定：不执行工作流、不注册工具、不写盘、不调模型。
 */
import { createHash } from "node:crypto";

import type { FoldCandidateAssessment, FoldCandidateInput } from "./workflow-fold-contract.js";

/** 一个验证用例。 */
export interface FoldVerificationCase {
  readonly caseIdentifier: string;
  /** 输入内容指纹（至少两种不同输入才能证明不是"单例巧合"）。 */
  readonly inputFingerprint: string;
  readonly outcomeKind: "passed" | "failed";
  /** 该用例是否覆盖**分支差异**（不同分支/部分失败）。 */
  readonly coversBranchDifference: boolean;
  /** 是否超出前置条件（用于证明边界被验证）。 */
  readonly exceedsPreconditions: boolean;
}

/** 独立验证记录（**验收者必须与作者不同**）。 */
export interface FoldVerificationRecord {
  readonly verifierAgentInstanceId: string;
  readonly cases: ReadonlyArray<FoldVerificationCase>;
  /** 验证是否基于原始工作流的可复跑证据。 */
  readonly isEvidenceBacked: boolean;
}

/** 注册结论。 */
export type FoldPackageRegistrationOutcome =
  | {
      readonly kind: "registered";
      readonly toolIdentifier: string;
      readonly version: number;
      readonly bundleFingerprint: string;
      readonly reason: string;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "candidate-not-accepted"
        | "author-verified-own-work"
        | "insufficient-inputs"
        | "no-counterexample-coverage"
        | "not-evidence-backed"
        | "unregistered-permission-widening"
        | "version-conflict"
        | "missing-version-or-identifier";
      readonly reason: string;
    };

/** 已注册版本（用于幂等/冲突判定）。 */
export interface RegisteredFoldPackage {
  readonly toolIdentifier: string;
  readonly version: number;
  readonly bundleFingerprint: string;
}

function computeBundleFingerprint(input: {
  readonly candidate: FoldCandidateInput;
  readonly toolIdentifier: string;
  readonly version: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.toolIdentifier,
        input.version,
        input.candidate.originalWorkflowReference,
        input.candidate.preconditions,
        input.candidate.parameters.map((parameter) => [
          parameter.parameterName,
          parameter.effectKind,
          parameter.schemaJson,
        ]),
      ]),
    )
    .digest("hex");
}

/**
 * 把"已通过折叠校验的候选 + 独立验证"登记为可复用包。
 *
 * 拒绝条件（全部 fail-closed）：
 * 1. 候选未通过 FOLD-01-01 校验；
 * 2. **作者自己验收**（`authorAgentInstanceId === verifierAgentInstanceId`）；
 * 3. 验证用例少于 2 种不同输入；
 * 4. 没有任何用例覆盖**分支差异/部分失败**；
 * 5. 验证不是证据驱动（无原始工作流可复跑证据）；
 * 6. 展开后的每步骤权限**超出原工作流已批准集合**（需重新授权）；
 * 7. 同 `toolIdentifier` 不同版本内容 ⇒ 冲突；同版本同内容 ⇒ 幂等重放（**不重复登记**）；
 * 8. 缺标识/版本。
 */
export function registerFoldPackage(input: {
  readonly authorAgentInstanceId: string;
  readonly toolIdentifier: string;
  readonly version: number;
  readonly candidateAssessment: FoldCandidateAssessment;
  readonly verification: FoldVerificationRecord;
  readonly expandedStepPermissions: ReadonlyArray<string>;
  readonly previouslyApprovedStepPermissions: ReadonlyArray<string>;
  readonly existingPackages: ReadonlyArray<RegisteredFoldPackage>;
}): FoldPackageRegistrationOutcome {
  if (input.candidateAssessment.kind !== "accepted") {
    return {
      kind: "rejected",
      reasonCode: "candidate-not-accepted",
      reason: "候选未通过 FOLD-01-01 校验（等价范围/不可折叠项/副作用参数不满足）。",
    };
  }
  if (input.toolIdentifier.trim() === "" || !Number.isInteger(input.version) || input.version < 1) {
    return {
      kind: "rejected",
      reasonCode: "missing-version-or-identifier",
      reason: "缺少工具标识或合法版本号。",
    };
  }
  if (input.verification.verifierAgentInstanceId === input.authorAgentInstanceId) {
    return {
      kind: "rejected",
      reasonCode: "author-verified-own-work",
      reason: "作者不得验收自己的产出：必须由不同 Agent 独立验证。",
    };
  }
  const distinctInputFingerprints = new Set(
    input.verification.cases.map((testCase) => testCase.inputFingerprint),
  );
  if (distinctInputFingerprints.size < 2) {
    return {
      kind: "rejected",
      reasonCode: "insufficient-inputs",
      reason: "验证用例少于两种不同输入：单例成功不能证明等价。",
    };
  }
  if (!input.verification.cases.some((testCase) => testCase.coversBranchDifference)) {
    return {
      kind: "rejected",
      reasonCode: "no-counterexample-coverage",
      reason: "没有覆盖分支差异/部分失败的反例：等价范围未验证。",
    };
  }
  if (!input.verification.isEvidenceBacked) {
    return {
      kind: "rejected",
      reasonCode: "not-evidence-backed",
      reason: "验证没有原始工作流的可复跑证据。",
    };
  }
  const hasUnapprovedPermission = input.expandedStepPermissions.some(
    (permission) => !input.previouslyApprovedStepPermissions.includes(permission),
  );
  if (hasUnapprovedPermission) {
    return {
      kind: "rejected",
      reasonCode: "unregistered-permission-widening",
      reason: "展开后的步骤权限超出原工作流已批准集合：需重新授权，不能借折叠扩权。",
    };
  }

  const bundleFingerprint = computeBundleFingerprint({
    candidate: input.candidateAssessment.candidate,
    toolIdentifier: input.toolIdentifier,
    version: input.version,
  });

  const sameVersion = input.existingPackages.find(
    (existingPackage) =>
      existingPackage.toolIdentifier === input.toolIdentifier &&
      existingPackage.version === input.version,
  );
  if (sameVersion !== undefined) {
    if (sameVersion.bundleFingerprint === bundleFingerprint) {
      return {
        kind: "registered",
        toolIdentifier: input.toolIdentifier,
        version: input.version,
        bundleFingerprint,
        reason: "同版本同内容：幂等重放，不重复登记。",
      };
    }
    return {
      kind: "rejected",
      reasonCode: "version-conflict",
      reason: "同工具同版本但内容不同：拒绝覆盖既有版本（需升版本）。",
    };
  }

  return {
    kind: "registered",
    toolIdentifier: input.toolIdentifier,
    version: input.version,
    bundleFingerprint,
    reason: "候选已通过独立验证与权限校验：登记为版本化可复用包。",
  };
}
