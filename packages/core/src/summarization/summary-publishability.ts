/**
 * SEC-02-06 通道 12（2026-10-28）：**摘要/记忆写入前的内容检查**。
 *
 * 审查结论：`summarization/` 目前**没有生产消费者**（模块内部生成/读取，未注入提示词）；
 * 但一旦接入，摘要会带着源内容的凭据风险进入模型上下文。所以先在**写入侧**加闸：
 * 摘要片段在落盘前用同一份检测器目录做四态扫描，**不干净的片段不落盘**（如实计数）。
 *
 * 边界（必须说清）：
 * - 本模块**不脱敏**：命中即**不发布该片段**（不改变原文后继续发布）；
 * - 结果不包含命中内容，只含规则标识与规则版本（诊断不成为第二次泄漏）；
 * - 不宣称"摘要已安全"：只是"该片段没有命中已知规则且扫描完成"。
 */
import { scanSensitiveContent } from "../tools/sensitive-content-scan-contract.js";
import type { SensitiveScanResult } from "../tools/sensitive-content-scan-contract.js";

export interface SummaryPublishabilityEvaluation {
  readonly isPublishable: boolean;
  readonly outcome: SensitiveScanResult["outcome"];
  readonly ruleSetVersion: number;
  readonly matchedRuleIdentifiers: readonly string[];
  readonly limitReason: string | null;
  /** 给日志/诊断用的稳定原因（**不含摘要正文**）。 */
  readonly reason: string;
}

/** 判定一段摘要文本能否落盘/注入（只有 `clean` 可发布）。 */
export function evaluateSummaryPublishability(summaryText: string): SummaryPublishabilityEvaluation {
  const scanResult = scanSensitiveContent({ content: summaryText });
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
