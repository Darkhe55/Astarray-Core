/**
 * AXIOMATIC-DESIGN 阶段③（P3，2026-11-26）：**工具基线权限解析**（纯函数）。
 *
 * 从 `main-controller` 抽出：此前 `listPermissionToolOverview` 内的 `strictest` 与
 * `computeCapabilityBaseline` 是**同一规则的重复实现**，且埋在 6000 行控制器里。
 *
 * 规则（与既有实现逐字一致）：
 * 1. 没有权限组 ⇒ `null`（未知，不猜）；
 * 2. 无能力映射 ⇒ 取显式工具决定（可空）；
 * 3. 有能力映射 ⇒ 逐个能力求最严：`deny` 立即胜出、`ask` 降级为询问；
 *    **显式工具决定覆盖能力聚合结果**（存在即优先）；
 * 4. 否则回退到能力聚合值（默认 allow）。
 *
 * 纯函数：不做 I/O、不读存储、不联网。
 */
export type PermissionDecisionValue = "deny" | "ask" | "allow";

export interface PermissionProfileView {
  readonly capabilityDecisions: Record<string, PermissionDecisionValue>;
  readonly toolDecisions?: Record<string, PermissionDecisionValue>;
  readonly fallbackDecision: PermissionDecisionValue;
}

/**
 * 解析某工具（给定能力集合）的基线决定。
 */
export function resolveToolBaselineDecision(
  profile: PermissionProfileView | null,
  capabilityIds: readonly string[],
  toolName: string,
): PermissionDecisionValue | null {
  if (profile === null) return null;
  const explicit = profile.toolDecisions?.[toolName];
  if (capabilityIds.length === 0) return explicit ?? null;

  let decision: PermissionDecisionValue = "allow";
  for (const capabilityId of capabilityIds) {
    const current = profile.capabilityDecisions[capabilityId] ?? profile.fallbackDecision;
    if (current === "deny") return "deny";
    if (current === "ask") decision = "ask";
  }
  return explicit ?? decision;
}
