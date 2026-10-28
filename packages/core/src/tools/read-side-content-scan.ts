/**
 * SEC-02-06 通道 12（2026-10-28）：**读取侧的扫描标注**。
 *
 * 目的：让"这份派生内容（摘要/记忆/汇报）在被使用前**是否检查过**"可见。
 * 本模块**只标注**：
 * - **不改内容**（不脱敏、不截断、不替换）；
 * - **不阻断**（读取方仍拿到原文，由调用方决定怎么用）；
 * - 标注本身也不含正文，只含结论、规则版本与时间。
 *
 * 与写入侧（ADR-0086/0087）的分工：
 * 写入侧保证"不干净的东西不进存储"；读取侧保证"用了什么、检查结论是什么"可被看到。
 */
import { scanSensitiveContent } from "./sensitive-content-scan-contract.js";
import type { SensitiveScanResult } from "./sensitive-content-scan-contract.js";

export interface ReadSideContentScanLabel {
  readonly outcome: SensitiveScanResult["outcome"];
  readonly ruleSetVersion: number;
  readonly matchedRuleIdentifiers: readonly string[];
  readonly limitReason: string | null;
  /** 恒 true：本标注是在**读取时**算出来的，不是写入时的结论。 */
  readonly isEvaluatedAtReadTime: true;
  readonly evaluatedAtIso: string;
  /** 只有 `clean` 才是 true；**不要**把它当"其余内容都危险"的等价判断。 */
  readonly isClean: boolean;
}

export function buildReadSideContentScanLabel(
  contentText: string,
  nowIso: string = new Date().toISOString(),
): ReadSideContentScanLabel {
  const scanResult = scanSensitiveContent({ content: contentText });
  return {
    outcome: scanResult.outcome,
    ruleSetVersion: scanResult.ruleSetVersion,
    matchedRuleIdentifiers: [...scanResult.matchedRuleIdentifiers],
    limitReason: scanResult.limitReason,
    isEvaluatedAtReadTime: true,
    evaluatedAtIso: nowIso,
    isClean: scanResult.outcome === "clean",
  };
}
