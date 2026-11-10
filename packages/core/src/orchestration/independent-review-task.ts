/**
 * ALIGN-03-01（2026-11-10 续）：**真实审查任务**——派发节点与报告解析。
 *
 * 上一轮已经把"产物存在性"从验收结论里剥离（见 `artifact-precondition.ts`）。
 * 本轮补上闭环的另一半：
 *
 *   执行任务完成 + 产物前置通过
 *        ⇒ 注入一个 `taskType: "review"` 的**真实审查任务**（指派给审查者）
 *        ⇒ 审查任务产出报告文件，报告里**明确写出裁决**
 *        ⇒ 解析报告 ⇒ 记录裁决 ⇒ 任务转 `accepted` / `rework`
 *
 * 关键约束（对应用户裁决）：
 *  - 审查裁决**只能来自审查任务的报告**，不能来自产物是否存在；
 *  - 报告缺失或格式不合规 ⇒ 一律 `rework`（`check:review-verdict-missing`），
 *    **不得**默认通过；
 *  - 审查任务未完成 ⇒ 停在待验收（由 `independent-review-closure.ts` 的状态机保证）。
 */
import type { TaskDependencyNode } from "../core/types.js";

/** 报告里声明裁决的行格式（大小写不敏感，允许前后空白）。 */
export const REVIEW_VERDICT_LINE_PREFIX = "VERDICT:";
/** 报告里声明证据的行格式；可多行。 */
export const REVIEW_EVIDENCE_LINE_PREFIX = "EVIDENCE:";

export interface BuildReviewTaskNodeInput {
  readonly reviewedTaskIdentifier: string;
  readonly reviewerAgentInstanceId: string;
  readonly acceptanceCriteria: string | null;
  /** 送审产物路径（来自完成收据）；审查者据此复核，报告证据必须引用其中之一。 */
  readonly artifactPaths?: readonly string[];
  /** 审查任务自身标识；缺省按 `review:<reviewedTaskId>` 生成。 */
  readonly reviewTaskIdentifier?: string;
}

/** 审查任务的标识约定（幂等：同一执行任务只应有一个审查任务）。 */
export function buildReviewTaskIdentifier(reviewedTaskIdentifier: string): string {
  return `review:${reviewedTaskIdentifier}`;
}

/**
 * 构造审查任务节点。
 *
 * - `taskType: "review"` —— 调度与后续判定据此**不**再给审查任务派生审查任务（防递归）；
 * - `dependsOn: [reviewedTaskIdentifier]` —— 执行任务完成前不会被调度；
 * - `assignedAgentId: reviewerAgentInstanceId` —— 指派给**审查者**，不是执行者；
 * - `resultLocation: null` —— 由审查任务自己产出报告，不预设路径。
 */
export function buildReviewTaskNode(input: BuildReviewTaskNodeInput): TaskDependencyNode {
  const reviewTaskIdentifier =
    input.reviewTaskIdentifier ?? buildReviewTaskIdentifier(input.reviewedTaskIdentifier);
  const criteria =
    input.acceptanceCriteria === null || input.acceptanceCriteria.trim() === ""
      ? "未声明（按任务描述与产物判断）"
      : input.acceptanceCriteria;
  return {
    id: reviewTaskIdentifier,
    description:
      "独立审查任务：审查 " +
      input.reviewedTaskIdentifier +
      " 的产物与证据，并在报告中写明裁决。\n" +
      "报告格式（逐行）：\n" +
      REVIEW_VERDICT_LINE_PREFIX +
      " accept|rework\n" +
      REVIEW_EVIDENCE_LINE_PREFIX +
      " <可复核引用>\n" +
      "验收要求：" +
      criteria +
      (input.artifactPaths === undefined || input.artifactPaths.length === 0
        ? ""
        : "\n送审产物（证据必须引用其中之一）：\n" +
          input.artifactPaths.map((path) => "EVIDENCE: artifact:" + path).join("\n")),
    dependsOn: [input.reviewedTaskIdentifier],
    taskType: "review",
    toolNames: [],
    assignedAgentId: input.reviewerAgentInstanceId,
    status: "pending",
    resultLocation: null,
    acceptanceCriteria: criteria,
  };
}

export interface ReviewVerdictReport {
  readonly verdict: "merge-ready" | "rework";
  readonly evidenceReferences: readonly string[];
  readonly reason: string;
}

/**
 * 解析审查报告。
 *
 * 返回 `null` 表示**报告不合规**（没有 `VERDICT:` 行，或取值不是 accept/rework）。
 * 调用方必须把 `null` 当作**未通过**处理，不得默认通过。
 */
export function parseReviewVerdictReport(reportText: string): ReviewVerdictReport | null {
  const lines = reportText.split(/\r?\n/u);
  let declaredVerdict: string | null = null;
  const evidenceReferences: string[] = [];
  for (const line of lines) {
    const trimmedLine = line.trim();
    const upperCaseLine = trimmedLine.toUpperCase();
    if (upperCaseLine.startsWith(REVIEW_VERDICT_LINE_PREFIX)) {
      if (declaredVerdict === null) {
        declaredVerdict = trimmedLine
          .slice(REVIEW_VERDICT_LINE_PREFIX.length)
          .trim()
          .toLowerCase();
      }
      continue;
    }
    if (upperCaseLine.startsWith(REVIEW_EVIDENCE_LINE_PREFIX)) {
      const reference = trimmedLine.slice(REVIEW_EVIDENCE_LINE_PREFIX.length).trim();
      if (reference !== "") {
        evidenceReferences.push(reference);
      }
    }
  }
  if (declaredVerdict !== "accept" && declaredVerdict !== "rework") {
    return null;
  }
  if (declaredVerdict === "rework") {
    return {
      verdict: "rework",
      evidenceReferences,
      reason: "审查报告判定返修。",
    };
  }
  /** 判定通过但**没有证据** ⇒ 视为不合规（不能只凭一句话通过）。 */
  if (evidenceReferences.length === 0) {
    return null;
  }
  return {
    verdict: "merge-ready",
    evidenceReferences,
    reason: "审查报告判定通过，并给出证据引用。",
  };
}

export interface ResolveReviewVerdictInput {
  readonly projectRootPath: string;
  readonly reviewTaskIdentifier: string;
  /** 审查任务登记的报告路径（相对项目根）；未登记时为空。 */
  readonly resultLocation: string | null;
  readonly reviewOutcome: "success" | "failure";
  /**
   * 送审产物路径。给出时，报告的 `EVIDENCE: artifact:*` **必须**命中其中之一，
   * 否则视为证据不匹配 ⇒ rework（防止审查者引用别的文件冒充本次产物）。
   */
  readonly expectedArtifactPaths?: readonly string[];
}

export interface ResolvedReviewVerdict {
  readonly verdict: "merge-ready" | "rework";
  readonly evidenceReferences: readonly string[];
  readonly reason: string;
}

/**
 * 由**审查任务的报告**解析裁决（唯一合法来源）。
 *
 * 任何异常路径都收敛为 `rework` 并带具体检查引用：
 *  - 审查任务失败 ⇒ `check:review-task-failed:<task>`
 *  - 未登记报告路径 ⇒ `check:review-report-unregistered:<task>`
 *  - 报告不可读 ⇒ `check:review-report-unreadable:<path>`
 *  - 报告不合规（无裁决行 / 通过无证据）⇒ `check:review-verdict-missing:<path>`
 *
 * **永不抛错、永不默认通过。**
 */
export async function resolveReviewVerdict(
  input: ResolveReviewVerdictInput,
): Promise<ResolvedReviewVerdict> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  if (input.reviewOutcome === "failure") {
    return {
      verdict: "rework",
      evidenceReferences: [`check:review-task-failed:${input.reviewTaskIdentifier}`],
      reason: "审查任务执行失败：没有可采信的审查结论。",
    };
  }
  const reportLocation = input.resultLocation?.trim() ?? "";
  if (reportLocation === "") {
    return {
      verdict: "rework",
      evidenceReferences: [`check:review-report-unregistered:${input.reviewTaskIdentifier}`],
      reason: "审查任务未登记报告路径：没有可采信的审查结论。",
    };
  }
  const reportText = await readFile(join(input.projectRootPath, reportLocation), "utf8").catch(
    () => null,
  );
  if (reportText === null) {
    return {
      verdict: "rework",
      evidenceReferences: [`check:review-report-unreadable:${reportLocation}`],
      reason: "审查报告不可读取：" + reportLocation,
    };
  }
  const parsedReport = parseReviewVerdictReport(reportText);
  if (parsedReport === null) {
    return {
      verdict: "rework",
      evidenceReferences: [`check:review-verdict-missing:${reportLocation}`],
      reason:
        "审查报告缺少有效裁决行（需 VERDICT: accept|rework，且 accept 必须带 EVIDENCE）。",
    };
  }
  const expectedArtifactPaths = input.expectedArtifactPaths ?? [];
  if (parsedReport.verdict === "merge-ready" && expectedArtifactPaths.length > 0) {
    const citedArtifactPaths = parsedReport.evidenceReferences
      .filter((reference) => reference.startsWith("artifact:"))
      .map((reference) => reference.slice("artifact:".length).trim());
    const isMatched = citedArtifactPaths.some((cited) => expectedArtifactPaths.includes(cited));
    if (!isMatched) {
      return {
        verdict: "rework",
        evidenceReferences: [`check:review-evidence-mismatch:${reportLocation}`],
        reason:
          "审查报告的证据未引用本次送审产物（期望引用其中之一：" +
          expectedArtifactPaths.join("、") +
          "）。",
      };
    }
  }
  return {
    verdict: parsedReport.verdict,
    evidenceReferences: [`review-report:${reportLocation}`, ...parsedReport.evidenceReferences],
    reason: parsedReport.reason,
  };
}
/** 从审查任务描述里取回"送审产物路径"（构造时写入，供裁决校验用）。 */
export function parseReviewArtifactPathsFromDescription(
  description: string,
): readonly string[] {
  const paths: string[] = [];
  for (const line of description.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith(REVIEW_EVIDENCE_LINE_PREFIX)) continue;
    const reference = trimmedLine.slice(REVIEW_EVIDENCE_LINE_PREFIX.length).trim();
    if (!reference.startsWith("artifact:")) continue;
    const artifactPath = reference.slice("artifact:".length).trim();
    if (artifactPath !== "") paths.push(artifactPath);
  }
  return paths;
}
export interface DecideIndependentReviewInput {
  readonly projectRootPath: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly reviewerAgentInstanceId: string;
  readonly acceptanceCriteria: string | null;
  /** 完成收据里的落盘产物路径。 */
  readonly artifactPaths: readonly string[];
}

export type IndependentReviewDecision =
  | { readonly kind: "dispatch-review"; readonly reviewTask: TaskDependencyNode }
  | {
      readonly kind: "record-rework";
      readonly reason: string;
      readonly evidenceReferences: readonly string[];
    }
  | { readonly kind: "skip" };

/**
 * 决定"任务完成之后下一步做什么"——把控制器里的分支逻辑集中到可测函数。
 *
 * - 产物前置**满足** ⇒ `dispatch-review`（派真实审查任务，**不写裁决**）；
 * - 产物前置**不满足** ⇒ `record-rework`（返修，附具体检查项）；
 * - 任务本身是审查任务 ⇒ `skip`（防递归）。
 */
export async function decideIndependentReview(
  input: DecideIndependentReviewInput,
): Promise<IndependentReviewDecision> {
  const { evaluateArtifactPrecondition } = await import("./artifact-precondition.js");
  const precondition = await evaluateArtifactPrecondition({
    projectRootPath: input.projectRootPath,
    artifactPaths: input.artifactPaths,
  });
  if (!precondition.isSatisfied) {
    return {
      kind: "record-rework",
      reason: precondition.reason,
      evidenceReferences: [...precondition.evidenceReferences],
    };
  }
  return {
    kind: "dispatch-review",
    reviewTask: buildReviewTaskNode({
      reviewedTaskIdentifier: input.taskId,
      reviewerAgentInstanceId: input.reviewerAgentInstanceId,
      acceptanceCriteria: input.acceptanceCriteria,
      artifactPaths: precondition.confirmedArtifactPaths,
    }),
  };
}