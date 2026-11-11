/**
 * COORD-01-03（卡 §3）：**回复产物引用与实际版本的核对**。
 *
 * 卡内三条要求：
 * - 产物引用**未提供**时明确标 `not-provided`（已有）；
 * - 普通消息可合法无产物；
 * - **需要产物证明的审查/完成门禁不能凭缺失引用通过**；有引用时须**核对实际版本**。
 *
 * 本模块只做判定，不读文件：当前版本由调用方以解析器注入（本地可信来源，不让模型自证）。
 * 与既有完成证据的版本口径保持一致：引用版本**低于**当前版本 ⇒ 陈旧（stale）。
 */

export type ReplyArtifactReferenceState =
  /** 引用版本与当前版本一致。 */
  | "current"
  /** 当前版本已前进（引用陈旧）。 */
  | "stale"
  /** 解析不到该产物（不存在/无权读取）。 */
  | "missing"
  /** 引用版本**高于**当前版本：引用了尚未产生的版本。 */
  | "future";

export interface ReplyArtifactReferenceVerdict {
  readonly artifactIdentifier: string;
  readonly referencedRevision: number;
  readonly currentRevision: number | null;
  readonly state: ReplyArtifactReferenceState;
}

export interface ReplyArtifactVerificationResult {
  readonly verdicts: readonly ReplyArtifactReferenceVerdict[];
  /** 是否满足"需要产物证明"的门禁。 */
  readonly isSatisfied: boolean;
  readonly unsatisfiedReason: string | null;
}

/**
 * 核对一组产物引用。
 *
 * @param references 回复携带的引用（可为空）
 * @param resolveCurrentRevision 产物当前版本的本地权威解析（返回 null 表示解析不到）
 * @param isArtifactProofRequired 该门禁是否要求产物证明
 */
export async function verifyReplyArtifactReferences(input: {
  references: ReadonlyArray<{ artifactIdentifier: string; revision: number }>;
  resolveCurrentRevision: (artifactIdentifier: string) => Promise<number | null>;
  isArtifactProofRequired: boolean;
}): Promise<ReplyArtifactVerificationResult> {
  const verdicts: ReplyArtifactReferenceVerdict[] = [];
  for (const reference of input.references) {
    const currentRevision = await input.resolveCurrentRevision(reference.artifactIdentifier);
    let state: ReplyArtifactReferenceState;
    if (currentRevision === null) {
      state = "missing";
    } else if (reference.revision < currentRevision) {
      state = "stale";
    } else if (reference.revision > currentRevision) {
      state = "future";
    } else {
      state = "current";
    }
    verdicts.push({
      artifactIdentifier: reference.artifactIdentifier,
      referencedRevision: reference.revision,
      currentRevision,
      state,
    });
  }

  /** 缺引用且门禁要求产物证明 ⇒ 不通过（这一段是卡内明令，不得放宽）。 */
  if (input.isArtifactProofRequired && verdicts.length === 0) {
    return { verdicts, isSatisfied: false, unsatisfiedReason: "artifact-not-provided" };
  }
  if (input.isArtifactProofRequired) {
    const hasUnusableReference = verdicts.some((verdict) => verdict.state !== "current");
    if (hasUnusableReference) {
      const states = verdicts
        .filter((verdict) => verdict.state !== "current")
        .map((verdict) => `${verdict.artifactIdentifier}:${verdict.state}`)
        .join(", ");
      return { verdicts, isSatisfied: false, unsatisfiedReason: `artifact-not-current:${states}` };
    }
  }
  return { verdicts, isSatisfied: true, unsatisfiedReason: null };
}
