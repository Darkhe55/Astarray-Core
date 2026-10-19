/**
 * FOLD-01-03（2026-10-20 R106）：**折叠包内部的逐步授权**契约。
 *
 * 卡内依据（`docs/tasks/EXP01_...` §2 FOLD-01-03："工具内部逐步授权有效"）+ §1 共用边界。
 *
 * 问题：把一个多步工作流折叠成"一个工具"之后，**用户点一次"允许复用"不等于允许它内部所有动作**。
 * 若内部直接继承外层批准，就等于用一次宽授权换掉原本的逐步确认 —— 这是权限扩张。
 *
 * 判定纪律（全部 fail-closed）：
 * 1. **不得超出登记范围**：步骤需要的权限不在折叠包声明的 scope 内 ⇒ `deny`（不是"再问一次"）；
 * 2. **不可逆动作必须逐步确认**：`fs-delete`/`shell-exec` 即使在外层 scope 内，也要**每步**显式批准；
 * 3. **可逆动作可按"已授权能力"放行**：同一 run 内对同一能力的批准可复用（`isReusedGrant: true`），
 *    避免反复弹窗；但**不可逆动作的批准不跨 run 持久化**；
 * 4. **未知能力 ⇒ deny**（不认识就不猜）；
 * 5. 任何一步被拒绝 ⇒ 整个包运行**阻塞**并指出是哪一步（不跳到后续步骤"先做点别的"）。
 *
 * ## 边界
 * 不读写授权库、不执行工具：只对"这一步该放行还是该问"给出判定。
 */
/** 已知能力（白名单；未知一律拒绝）。 */
export const FOLD_KNOWN_CAPABILITIES = [
  "fs-read",
  "fs-write",
  "fs-delete",
  "shell-exec",
  "network-egress",
  "model-invoke",
] as const;

export type FoldCapability = (typeof FOLD_KNOWN_CAPABILITIES)[number];

/** 不可逆能力：每次执行都要显式批准，且批准不跨 run。 */
export const FOLD_IRREVERSIBLE_CAPABILITIES: ReadonlySet<FoldCapability> = new Set([
  "fs-delete",
  "shell-exec",
] as const);

/** 一个内部步骤。 */
export interface FoldPackageStep {
  readonly stepIdentifier: string;
  readonly requiredCapabilities: ReadonlyArray<string>;
}

/** 单步判定。 */
export type FoldStepAuthorizationDecision =
  | {
      readonly kind: "allow";
      readonly stepIdentifier: string;
      readonly isReusedGrant: boolean;
      readonly reason: string;
    }
  | {
      readonly kind: "ask-step";
      readonly stepIdentifier: string;
      readonly isIrreversible: boolean;
      readonly reason: string;
    }
  | {
      readonly kind: "deny";
      readonly stepIdentifier: string;
      readonly reasonCode: "outside-declared-scope" | "unknown-capability";
      readonly reason: string;
    };

/** 整包判定。 */
export interface FoldPackageAuthorizationReport {
  readonly decisions: ReadonlyArray<FoldStepAuthorizationDecision>;
  readonly isPackageRunBlocked: boolean;
  /** 阻塞发生在哪一步（未阻塞为 null）。 */
  readonly blockedAtStepIdentifier: string | null;
  /** 是否需要向用户逐步询问（存在 ask-step）。 */
  readonly requiresStepwisePrompts: boolean;
  /** 不可逆能力的批准**不跨 run 持久化**。 */
  readonly isIrreversibleGrantPersistent: false;
}

/** 逐级判定整包授权。 */
export function evaluateFoldPackageAuthorization(input: {
  readonly steps: ReadonlyArray<FoldPackageStep>;
  /** 折叠包**登记**时声明可用的能力集合（外层批准的 scope）。 */
  readonly declaredCapabilityScope: ReadonlySet<string>;
  /** 本次 run 内**已逐步批准**的能力（不含不可逆能力的持久批准）。 */
  readonly grantedCapabilitiesInRun: ReadonlySet<string>;
}): FoldPackageAuthorizationReport {
  const decisions: FoldStepAuthorizationDecision[] = [];
  let blockedAtStepIdentifier: string | null = null;

  for (const step of input.steps) {
    if (blockedAtStepIdentifier !== null) {
      // 已被阻塞：后续步骤不再判定（不"先做点别的"）
      break;
    }
    let askStepDecision: FoldStepAuthorizationDecision | null = null;
    for (const capability of step.requiredCapabilities) {
      const isKnownCapability = (FOLD_KNOWN_CAPABILITIES as ReadonlyArray<string>).includes(capability);
      if (!isKnownCapability) {
        decisions.push({
          kind: "deny",
          stepIdentifier: step.stepIdentifier,
          reasonCode: "unknown-capability",
          reason: `未知能力「${capability}」：不认识就不放行。`,
        });
        blockedAtStepIdentifier = step.stepIdentifier;
        break;
      }
      if (!input.declaredCapabilityScope.has(capability)) {
        decisions.push({
          kind: "deny",
          stepIdentifier: step.stepIdentifier,
          reasonCode: "outside-declared-scope",
          reason: `能力「${capability}」不在折叠包登记范围内：不得用外层批准换取越权。`,
        });
        blockedAtStepIdentifier = step.stepIdentifier;
        break;
      }
      const isIrreversibleCapability = FOLD_IRREVERSIBLE_CAPABILITIES.has(capability as FoldCapability);
      if (isIrreversibleCapability) {
        // 不可逆动作：即使 scope 内、即使本次 run 已批准同类能力，也必须**逐步**确认
        askStepDecision = {
          kind: "ask-step",
          stepIdentifier: step.stepIdentifier,
          isIrreversible: true,
          reason: `不可逆能力「${capability}」需逐步确认（批准不跨 run）。`,
        };
        continue;
      }
      if (!input.grantedCapabilitiesInRun.has(capability) && askStepDecision === null) {
        askStepDecision = {
          kind: "ask-step",
          stepIdentifier: step.stepIdentifier,
          isIrreversible: false,
          reason: `能力「${capability}」尚未在本次运行中批准：先问再做。`,
        };
      }
    }
    if (blockedAtStepIdentifier !== null) break;
    if (askStepDecision !== null) {
      decisions.push(askStepDecision);
      continue;
    }
    decisions.push({
      kind: "allow",
      stepIdentifier: step.stepIdentifier,
      isReusedGrant: step.requiredCapabilities.every((capability) =>
        input.grantedCapabilitiesInRun.has(capability),
      ),
      reason: "所需能力均已在登记范围内并获本次运行批准。",
    });
  }

  return {
    decisions,
    isPackageRunBlocked: blockedAtStepIdentifier !== null,
    blockedAtStepIdentifier,
    requiresStepwisePrompts: decisions.some((decision) => decision.kind === "ask-step"),
    isIrreversibleGrantPersistent: false,
  };
}
