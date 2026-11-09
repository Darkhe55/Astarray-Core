/**
 * ALIGN-03-01（2026-11-10）：**产物证据驱动的验收结论**（本地、非自报）。
 *
 * 为什么需要：卡内要求"同一执行任务的自报不能代替独立审查结论"。
 * 只做到"任命一个审查者"还不够 —— 没有结论，任务永远停在待裁决。
 *
 * 本模块产出的结论**只依据可复核的产物证据**（`artifact:<path>` + 字节数），
 * 证据前缀**不是** `self-report:`/`executor-report:`/`agent-claim:`，
 * 因此不会被独立验收门禁当成"执行者自报"而拒绝。
 *
 * **边界（必须如实标注）**：这是**本地产物存在性**验收，不是模型审查，
 * 也不是人工验收。它只能回答"产物是否真的产出且非空"，不能回答"内容是否正确"。
 */
import { checkOutputArtifact } from "./output-artifact-check.js";

export interface ProduceArtifactBackedVerdictInput {
  readonly projectRootPath: string;
  readonly taskIdentifier: string;
  readonly taskRevision: number;
  readonly resultLocation: string | null;
  /** 可选：绑定的提交哈希（有 Git 产物时由调用方给出）。 */
  readonly boundCommitHash?: string | null;
}

export interface ArtifactBackedVerdict {
  readonly verdict: "merge-ready" | "rework";
  readonly reason: string;
  readonly evidenceReferences: readonly string[];
}

/**
 * 产出结论：产物**存在且非空** ⇒ `merge-ready`；否则 ⇒ `rework`（带具体原因）。
 *
 * 注意：缺产物**不抛错**，而是给出 `rework` —— 抛错会让调用方把"未产出"
 * 误当成"审查失败"，两者语义不同。
 */
export async function produceArtifactBackedVerdict(
  input: ProduceArtifactBackedVerdictInput,
): Promise<ArtifactBackedVerdict> {
  const resultLocation = input.resultLocation?.trim() ?? "";
  if (resultLocation === "") {
    return {
      verdict: "rework",
      reason: "任务未登记产物路径：没有可复核的产出，不能判定为完成。",
      /** 证据是**检查结果**（不是执行者自报），否则门禁会拒绝"只有自报"的结论。 */
      evidenceReferences: ["check:result-location-unregistered"],
    };
  }
  const artifactCheck = await checkOutputArtifact({
    projectRootPath: input.projectRootPath,
    resultLocation,
  });
  if (artifactCheck.kind !== "present") {
    return {
      verdict: "rework",
      reason:
        "产物不可确认（" +
        artifactCheck.kind +
        "）：" +
        ("detail" in artifactCheck ? artifactCheck.detail : resultLocation),
      evidenceReferences: [`check:artifact-${artifactCheck.kind}:${resultLocation}`],
    };
  }
  return {
    verdict: "merge-ready",
    reason:
      "产物存在且非空（" +
      String(artifactCheck.byteSize) +
      " 字节），与任务登记的产物路径一致。",
    evidenceReferences: [
      `artifact:${resultLocation}`,
      `artifact-bytes:${String(artifactCheck.byteSize)}`,
      ...(input.boundCommitHash === undefined || input.boundCommitHash === null
        ? []
        : [`commit:${input.boundCommitHash}`]),
    ],
  };
}
