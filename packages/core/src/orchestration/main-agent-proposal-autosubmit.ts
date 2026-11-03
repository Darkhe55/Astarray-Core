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

/**
 * R147 补强（2026-11-03）：**用户任务引用由 harness 注入**。
 *
 * 模型看不到本地随机的 `user-message-<uuid>` 引用；若要求模型逐字复现，
 * 自动提交会**永远**因"引用不一致"被拒（等于功能不可用）。
 * 因此自动提交路径在提交前用会话已登记的引用覆盖模型字段；
 * 缺少已登记引用的会话保持原样，让契约层按"无用户来源"拒绝。
 */
export function injectHarnessUserTaskReference(
  record: Record<string, unknown>,
  harnessReference: string | undefined,
): Record<string, unknown> {
  if (harnessReference === undefined || harnessReference === "") {
    return record;
  }
  return { ...record, userTaskReference: harnessReference };
}