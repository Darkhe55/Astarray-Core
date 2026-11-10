/**
 * ALIGN-03-01（2026-11-10 修订）：**产物前置检查**——不是验收结论。
 *
 * 用户裁决：产物"存在且非空"**不得**直接算 `merge-ready`。
 * 因此本模块只回答一个问题："这次执行有没有可送审的产物？"
 * 它产出的结果叫 `ArtifactPrecondition`，**没有** `merge-ready` 这个值，
 * 从类型上就杜绝"产物存在即验收通过"。
 *
 * 验收结论只能来自**真实审查任务**（见 `independent-review-closure.ts`）。
 *
 * 边界：本模块只做本地文件检查（存在/非空/在项目根内），不读内容、不做模型审查。
 */
import { checkOutputArtifact } from "./output-artifact-check.js";

export interface EvaluateArtifactPreconditionInput {
  readonly projectRootPath: string;
  readonly resultLocation: string | null;
}

export interface ArtifactPrecondition {
  /** 是否满足送审前置条件（产物存在、非空、在项目根内）。 */
  readonly isSatisfied: boolean;
  /** 不满足时的具体原因（可读）。 */
  readonly reason: string;
  /**
   * 可复核证据：满足时是 `artifact:`/`artifact-bytes:`；
   * 不满足时是 `check:` 前缀的**检查结果**（不是执行者自报）。
   */
  readonly evidenceReferences: readonly string[];
  /** 不满足时的失败检查引用，便于返修单直接引用。 */
  readonly failureCheckReference: string | null;
}

/**
 * 检查产物前置条件。**永不抛出**：缺产物是正常结果（返修），不是异常。
 */
export async function evaluateArtifactPrecondition(
  input: EvaluateArtifactPreconditionInput,
): Promise<ArtifactPrecondition> {
  const resultLocation = input.resultLocation?.trim() ?? "";
  if (resultLocation === "") {
    return {
      isSatisfied: false,
      reason: "任务未登记产物路径：没有可送审的产出。",
      evidenceReferences: ["check:result-location-unregistered"],
      failureCheckReference: "check:result-location-unregistered",
    };
  }
  const artifactCheck = await checkOutputArtifact({
    projectRootPath: input.projectRootPath,
    resultLocation,
  });
  if (artifactCheck.kind !== "present") {
    const failureCheckReference = `check:artifact-${artifactCheck.kind}:${resultLocation}`;
    return {
      isSatisfied: false,
      reason:
        "产物不可确认（" +
        artifactCheck.kind +
        "）：" +
        ("detail" in artifactCheck ? artifactCheck.detail : resultLocation),
      evidenceReferences: [failureCheckReference],
      failureCheckReference,
    };
  }
  return {
    isSatisfied: true,
    reason:
      "产物存在且非空（" + String(artifactCheck.byteSize) + " 字节），可以送审。",
    evidenceReferences: [
      `artifact:${resultLocation}`,
      `artifact-bytes:${String(artifactCheck.byteSize)}`,
    ],
    failureCheckReference: null,
  };
}
