/**
 * ALIGN-03-01（2026-11-10 修订，方案 C）：**产物前置检查**——不是验收结论。
 *
 * 产物路径的权威来源是**完成收据**（`completion-receipt.ts` 的 `artifactPaths`，
 * 取自本地真实落盘状态），**不是**任务节点的 `resultLocation`：
 * 后者在既有流程里另有消费者，直接回填会把返修任务卡成 blocked（2026-11-10 实测）。
 *
 * 本模块只回答一个问题："这次执行有没有可送审的产物？"
 * 结果类型**没有** `merge-ready` —— 从类型上杜绝"产物存在即验收通过"。
 * 验收结论只能来自**真实审查任务**的报告（见 `independent-review-task.ts`）。
 */
import { checkOutputArtifact } from "./output-artifact-check.js";

export interface EvaluateArtifactPreconditionInput {
  readonly projectRootPath: string;
  /** 完成收据里的落盘产物路径（可多条；任一存在且非空即可送审）。 */
  readonly artifactPaths: readonly string[];
}

export interface ArtifactPrecondition {
  readonly isSatisfied: boolean;
  readonly reason: string;
  /** 满足时是被确认的 `artifact:`/`artifact-bytes:` 证据；不满足时是 `check:` 检查结果。 */
  readonly evidenceReferences: readonly string[];
  /** 不满足时的失败检查引用（可直接写进返修单）。 */
  readonly failureCheckReference: string | null;
  /** 被确认存在且非空的产物路径（满足时非空；审查任务据此复核）。 */
  readonly confirmedArtifactPaths: readonly string[];
}

/**
 * 检查产物前置条件。**永不抛出**：缺产物是正常结果（返修），不是异常。
 */
export async function evaluateArtifactPrecondition(
  input: EvaluateArtifactPreconditionInput,
): Promise<ArtifactPrecondition> {
  const declaredPaths = input.artifactPaths
    .map((path) => path.trim())
    .filter((path) => path !== "");
  if (declaredPaths.length === 0) {
    return {
      isSatisfied: false,
      reason: "完成收据未记录任何落盘产物：没有可送审的产出。",
      evidenceReferences: ["check:artifact-paths-unregistered"],
      failureCheckReference: "check:artifact-paths-unregistered",
      confirmedArtifactPaths: [],
    };
  }
  const confirmedArtifactPaths: string[] = [];
  const evidenceReferences: string[] = [];
  const failureReferences: string[] = [];
  for (const artifactPath of declaredPaths) {
    const artifactCheck = await checkOutputArtifact({
      projectRootPath: input.projectRootPath,
      resultLocation: artifactPath,
    });
    if (artifactCheck.kind === "present") {
      confirmedArtifactPaths.push(artifactPath);
      evidenceReferences.push(`artifact:${artifactPath}`);
      evidenceReferences.push(`artifact-bytes:${String(artifactCheck.byteSize)}`);
      continue;
    }
    failureReferences.push(`check:artifact-${artifactCheck.kind}:${artifactPath}`);
  }
  if (confirmedArtifactPaths.length > 0) {
    return {
      isSatisfied: true,
      reason:
        "完成收据记录的产物中已有 " +
        String(confirmedArtifactPaths.length) +
        " 条存在且非空，可以送审。",
      evidenceReferences,
      failureCheckReference: null,
      confirmedArtifactPaths,
    };
  }
  return {
    isSatisfied: false,
    reason:
      "完成收据记录的产物均不可确认（共 " +
      String(declaredPaths.length) +
      " 条）：没有可送审的产出。",
    evidenceReferences: failureReferences,
    failureCheckReference: failureReferences[0] ?? "check:artifact-paths-unregistered",
    confirmedArtifactPaths: [],
  };
}
