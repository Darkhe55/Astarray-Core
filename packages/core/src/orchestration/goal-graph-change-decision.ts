/**
 * R134（2026-11-02）：图变更后是否暂停目标（纯判定）。
 *
 * 规则：只有 V **上升**（有要求失去证据）才暂停并要求重新规划；
 * V 不变、下降、无法计算时都不新增暂停（不打断正常推进）。
 */
export function shouldPauseForGraphChange(input: {
  readonly previousPotentialValue: number | null;
  readonly nextPotentialValue: number | null;
}): { readonly shouldPause: boolean; readonly reason: string | null } {
  if (input.nextPotentialValue === null) {
    return { shouldPause: false, reason: null };
  }
  if (input.previousPotentialValue === null) {
    return { shouldPause: false, reason: null };
  }
  if (input.nextPotentialValue <= input.previousPotentialValue) {
    return { shouldPause: false, reason: null };
  }
  return {
    shouldPause: true,
    reason: `V 上升：${String(input.previousPotentialValue)} → ${String(input.nextPotentialValue)}`,
  };
}
