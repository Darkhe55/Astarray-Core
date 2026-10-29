/**
 * R15（2026-10-29）：**提示词扫描标注的运行记录**（环形缓冲）。
 *
 * 目的：ADR-0103 只让装配结果"带结论"，但没有任何地方记录它 —— 事后无法回答
 * "某次注入前上下文是否检查过"。本模块提供**有界**记录（进程内 100 条），
 * 与 `provider-egress-scan` 的环形缓冲同款纪律：
 *
 * - **只记录结论**（mission / agent / task / 结论 / 规则版本 / 命中规则 / 时间），
 *   **不记录提示词正文**（避免诊断变成第二次泄漏）；
 * - **不阻断**：记录失败/缺失都不改变装配与派发；
 * - 进程内、无持久化（持久化属后续检查点，避免把一次性诊断写成产品存储）。
 */
import type { ReadSideContentScanLabel } from "../tools/read-side-content-scan.js";

export interface PromptContentScanRecord {
  readonly missionIdentifier: string;
  readonly agentInstanceIdentifier: string;
  readonly taskIdentifier: string;
  readonly outcome: ReadSideContentScanLabel["outcome"];
  readonly ruleSetVersion: number;
  readonly matchedRuleIdentifiers: readonly string[];
  readonly limitReason: string | null;
  readonly isClean: boolean;
  readonly recordedAtIso: string;
}

/** 环形缓冲上限（与出口扫描一致，避免无界内存）。 */
export const MAXIMUM_PROMPT_CONTENT_SCAN_RECORDS = 100;

const promptContentScanRecords: PromptContentScanRecord[] = [];

/** 记录一次装配标注（由 provider 调用；不含正文）。 */
export function recordPromptContentScan(
  input: Omit<PromptContentScanRecord, "recordedAtIso"> & {
    readonly recordedAtIso?: string;
  },
): PromptContentScanRecord {
  const record: PromptContentScanRecord = {
    missionIdentifier: input.missionIdentifier,
    agentInstanceIdentifier: input.agentInstanceIdentifier,
    taskIdentifier: input.taskIdentifier,
    outcome: input.outcome,
    ruleSetVersion: input.ruleSetVersion,
    matchedRuleIdentifiers: [...input.matchedRuleIdentifiers],
    limitReason: input.limitReason,
    isClean: input.isClean,
    recordedAtIso: input.recordedAtIso ?? new Date().toISOString(),
  };
  promptContentScanRecords.push(record);
  if (promptContentScanRecords.length > MAXIMUM_PROMPT_CONTENT_SCAN_RECORDS) {
    promptContentScanRecords.shift();
  }
  return record;
}

/** 读取最近记录（只读副本；供诊断/后续 UI）。 */
export function readPromptContentScanRecords(): readonly PromptContentScanRecord[] {
  return [...promptContentScanRecords];
}

/** 清空（测试/诊断用；不影响真实装配）。 */
export function clearPromptContentScanRecords(): void {
  promptContentScanRecords.length = 0;
}
