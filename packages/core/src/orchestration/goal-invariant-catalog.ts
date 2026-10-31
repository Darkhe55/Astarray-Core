/**
 * R78（2026-10-31）：**可核对的不可违反项（安全不变量）清单**（K4）。
 *
 * 背景：`nonViolableInvariants` 原是自由文本，既无法与本地违规信号匹配，也不会被任何代码检查。
 * 这里把它收窄为**有限枚举**，并明确每个标识的**违规来源**：
 *
 * | 标识 | 违规来源（本地、可核对） |
 * |---|---|
 * | `tool.permission-denied` | 工具权限门禁拒绝（`DomainError.code === "tool-permission-denied"`） |
 * | `scope.project-boundary` | 作用域/项目边界拒绝（保留；当前由权限拒绝路径覆盖） |
 * | `storage.protected-write` | 受保护存储写入拒绝（保留） |
 * | `installation.gate` | 安装门禁拒绝（保留） |
 *
 * 只有 `tool.permission-denied` 目前有**生产者**（见 `main-controller` 的工具端口装饰）；
 * 其余为保留标识，写入契约合法但暂时不会被触发，不能声称"已生效"。
 */

export const GOAL_INVARIANT_CODES = [
  "tool.permission-denied",
  "scope.project-boundary",
  "storage.protected-write",
  "installation.gate",
] as const;

export type GoalInvariantCode = (typeof GOAL_INVARIANT_CODES)[number];

const KNOWN_INVARIANT_CODES = new Set<string>(GOAL_INVARIANT_CODES);

export function isKnownGoalInvariantCode(value: string): boolean {
  return KNOWN_INVARIANT_CODES.has(value);
}

/**
 * R98（2026-11-01）：**违规记录上限**（有界，避免长跑目标状态无限增长）。
 *
 * 与判定记录一致：只保留最近 N 条；旧记录被丢弃（不是归档，保留"最近事实"）。
 */
export const GOAL_INVARIANT_VIOLATION_LIMIT = 200;

export function appendBoundedInvariantViolation(
  existing: readonly {
    readonly invariantCode: string;
    readonly detail: string;
    readonly recordedAtIso: string;
  }[],
  violation: {
    readonly invariantCode: string;
    readonly detail: string;
    readonly recordedAtIso: string;
  },
  limit: number = GOAL_INVARIANT_VIOLATION_LIMIT,
): {
  readonly invariantCode: string;
  readonly detail: string;
  readonly recordedAtIso: string;
}[] {
  const combined = [...existing, violation];
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}