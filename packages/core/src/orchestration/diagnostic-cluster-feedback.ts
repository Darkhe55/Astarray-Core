import { promises as fs } from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "./diagnostic-event-store.js";
import { resolveClusterIndexDirectory } from "./diagnostic-cluster-index.js";

/**
 * CLUSTER-01 §5：**用户纠正记录**（feedback）。
 *
 * 卡内硬约束：
 * - 反馈是"用户/有权 Agent 的意见"，**保存精确来源身份**；
 * - **不修改原始事件**、**不直接改算法**、**不自动重分组**；
 * - 查看组时展示相关意见及**冲突**，且**不把意见视为事实**。
 *
 * 因此本模块只做"追加 + 读取 + 冲突标记"，不触碰快照文件。
 */

export type DiagnosticClusterFeedbackVerdict = "agree" | "disagree" | "note";

export interface DiagnosticClusterFeedbackInput {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly groupIdentifier: string;
  readonly verdict: DiagnosticClusterFeedbackVerdict;
  /** 精确来源身份（用户 ID 或 Agent 个体 ID）；不得为空。 */
  readonly sourceIdentity: string;
  readonly sourceKind: "user" | "agent";
  readonly recordedAtIso: string;
  readonly noteText: string;
}

export interface DiagnosticClusterFeedbackRecord extends DiagnosticClusterFeedbackInput {
  readonly feedbackIdentifier: string;
  /** 恒为 false：意见不是事实（卡内要求不得把意见当事实）。 */
  readonly isFact: false;
}

export interface DiagnosticClusterFeedbackSummary {
  readonly groupIdentifier: string;
  readonly records: readonly DiagnosticClusterFeedbackRecord[];
  /** 同一组里出现互相矛盾的 verdict（agree 与 disagree 并存）⇒ 必须显式标冲突。 */
  readonly hasConflict: boolean;
  readonly isFact: false;
}

function resolveFeedbackFilePath(stateDirectory: string, projectIdentifier: string): string {
  return path.join(resolveClusterIndexDirectory(stateDirectory, projectIdentifier), "feedback.jsonl");
}

/** 追加一条意见；**不触碰快照文件**（卡内要求不改原始事件）。 */
export async function appendDiagnosticClusterFeedback(
  input: DiagnosticClusterFeedbackInput,
): Promise<DiagnosticClusterFeedbackRecord> {
  if (input.sourceIdentity.trim() === "") {
    throw new Error("feedback-source-identity-required");
  }
  const record: DiagnosticClusterFeedbackRecord = {
    ...input,
    noteText: redactSensitiveText(input.noteText),
    feedbackIdentifier: `${input.groupIdentifier}#${input.recordedAtIso}#${input.sourceIdentity}`,
    isFact: false,
  };
  const filePath = resolveFeedbackFilePath(input.stateDirectory, input.projectIdentifier);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  return record;
}

/** 读取某组的意见汇总；文件不存在视为"还没有意见"（不是错误）。 */
export async function readDiagnosticClusterFeedback(input: {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly groupIdentifier: string;
}): Promise<DiagnosticClusterFeedbackSummary> {
  const filePath = resolveFeedbackFilePath(input.stateDirectory, input.projectIdentifier);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { groupIdentifier: input.groupIdentifier, records: [], hasConflict: false, isFact: false };
    }
    throw new Error("feedback-source-unavailable", { cause: error });
  }
  const records: DiagnosticClusterFeedbackRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as DiagnosticClusterFeedbackRecord;
      if (parsed.groupIdentifier === input.groupIdentifier) records.push(parsed);
    } catch {
      /** 损坏行跳过，不影响其余意见（不因此返回"没有意见"）。 */
    }
  }
  records.sort((left, right) => (left.recordedAtIso < right.recordedAtIso ? -1 : 1));
  const verdicts = new Set(records.map((record) => record.verdict));
  return {
    groupIdentifier: input.groupIdentifier,
    records,
    hasConflict: verdicts.has("agree") && verdicts.has("disagree"),
    isFact: false,
  };
}
