/**
 * SEC-02-06 通道 12（2026-10-28）：**摘要写入前的内容检查**。
 *
 * 审查结论：`summarization/` 目前**没有生产消费者**（模块内部生成/读取，未注入提示词）；
 * 但一旦接入，摘要会带着源内容的凭据风险进入模型上下文。所以先在**写入侧**加闸：
 * 摘要片段在落盘前用同一份检测器目录做四态扫描，**不干净的片段不落盘**（如实计数）。
 *
 * 本模块是 `tools/content-publishability.ts` 的**摘要侧薄封装**（保持既有调用点稳定）；
 * 记忆/汇报等派生内容请直接用通用版本。
 */
import {
  evaluateContentPublishability,
  type ContentPublishabilityEvaluation,
} from "../tools/content-publishability.js";

export type SummaryPublishabilityEvaluation = ContentPublishabilityEvaluation;

/** 判定一段摘要文本能否落盘/注入（只有 `clean` 可发布）。 */
export function evaluateSummaryPublishability(
  summaryText: string,
): SummaryPublishabilityEvaluation {
  return evaluateContentPublishability(summaryText);
}
