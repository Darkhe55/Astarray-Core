/**
 * SEC-02-06 通道 12（2026-10-28）：**可落盘/可注入内容检查（通用）**。
 *
 * 用于"派生内容"（摘要片段、长期记忆、三级汇报）在写入前的一次四态扫描。
 * 与 `summary-publishability.ts` 同源，本模块是**通用版本**（不只服务摘要）。
 *
 * 边界：
 * - **不做脱敏**：命中即"不可发布"，由调用方拒绝落盘（不改变原文后继续写）；
 * - 结果**不含正文**，只有结论、规则标识、规则版本与限制原因；
 * - `clean` 只表示"扫描完成且未命中已知规则"，**不宣称内容安全**。
 */
import { scanSensitiveContent } from "./sensitive-content-scan-contract.js";
import type { SensitiveScanResult } from "./sensitive-content-scan-contract.js";

export interface ContentPublishabilityEvaluation {
  readonly isPublishable: boolean;
  readonly outcome: SensitiveScanResult["outcome"];
  readonly ruleSetVersion: number;
  readonly matchedRuleIdentifiers: readonly string[];
  readonly limitReason: string | null;
  /** 稳定原因（**不含正文**）。 */
  readonly reason: string;
}

export function evaluateContentPublishability(
  contentText: string,
): ContentPublishabilityEvaluation {
  const scanResult = scanSensitiveContent({ content: contentText });
  if (scanResult.outcome === "clean") {
    return {
      isPublishable: true,
      outcome: scanResult.outcome,
      ruleSetVersion: scanResult.ruleSetVersion,
      matchedRuleIdentifiers: [],
      limitReason: null,
      reason: "扫描完成且未命中已知规则。",
    };
  }
  const reason =
    scanResult.outcome === "sensitive"
      ? `命中规则 ${scanResult.matchedRuleIdentifiers.join(", ")}`
      : `${scanResult.outcome}: ${scanResult.limitReason ?? "未知原因"}`;
  return {
    isPublishable: false,
    outcome: scanResult.outcome,
    ruleSetVersion: scanResult.ruleSetVersion,
    matchedRuleIdentifiers: [...scanResult.matchedRuleIdentifiers],
    limitReason: scanResult.limitReason,
    reason,
  };
}
