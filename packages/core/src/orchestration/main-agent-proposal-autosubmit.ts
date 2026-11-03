/**
 * R147（2026-11-03）：从主 Agent 输出中提取任务提案 JSON（纯函数）。
 *
 * 规则（保守）：
 * - 只接受"整段就是 JSON 对象"（可带 ```json 围栏）；
 * - 不是 JSON / 不是对象 / 不像提案（缺 `targetSecondaryAgentInstanceIdentifier`）⇒ null；
 * - 不做字段白名单校验（那由 `MainAgentTaskProposalContract` 负责，越权字段会被拒）。
 */
export function extractMainAgentProposalPayload(
  answerText: string,
): Record<string, unknown> | null {
  const trimmed = answerText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (trimmed === "" || !trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.targetSecondaryAgentInstanceIdentifier !== "string") {
    return null;
  }
  return record;
}
