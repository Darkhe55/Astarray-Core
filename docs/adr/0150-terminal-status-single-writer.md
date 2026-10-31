# ADR-0150 终态单点写入与目标状态合并（R86，2026-10-31）

- 状态：已采纳（目标状态修好；mission 终态仍被关闭流程抢先取消，见 §4）
- 来源：用户"继续"（修 ADR-0149 遗留 #1/#2）
- 相关：ADR-0149（治理停止）、ADR-0146（完成证据）

## 1. 改动

1. **终态单点写入** `MainController.finalizeMissionStatus(missionId, status)`：
   - 已是终态（done/cancelled/blocked）且新状态不同 ⇒ **忽略并记录** `[终态] 忽略 …`；
   - 例外：**`done` 允许覆盖"中断型 blocked"**（早停续跑后真实完成）。
2. **中断 ≠ 终态**：`onMissionGateBlocked`（早停/门禁失败）仍用普通 `updateMissionStatus("blocked")`，
   不进入终态单点——否则续跑完成后无法写 done（**G5 实测卡死 45s**）。
3. **目标状态合并**（`GoalModeStateStore.finishTaskGroup`）：以磁盘最新状态为基线合并，
   不再用组开始时读到的旧状态覆盖：
   - `pauseReason` 保留（除非新快照显式给出）；
   - `evidenceGaps` 取并集；
   - `requiresReplanning` 取或；
   - `consumedToolCalls` 取 max（含收据计数）。
4. **失败组的"已执行"事实**：控制器暴露 `getMissionExecutedToolCallCount`，
   治理停止时运行时用它补齐 `consumedToolCalls`（失败组不写收据）。

## 2. 真实复跑（goal-k10g，上限 1）

```
goal-mode status
→ isPaused: true
  pauseReason: "目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 listDirectory。"
  consumedToolCalls: 1        ← 修复前是 0
  evidenceGapCount: 1
  lastPotentialValue: 1
```

即：**暂停原因与"已消耗 1 次"都被保留**，不再被组结束的旧状态覆盖。

## 3. 回归（重要教训）

G5 早停续跑一度**稳定失败**（45s 卡在 running）：
- 原因 1：把 `onMissionGateBlocked` 也走终态单点 ⇒ 早停写成终态 blocked，续跑完成写 done 被拒；
- 原因 2：`finalizeMissionStatus` 把 blocked 当不可覆盖终态 ⇒ 同样拒绝 done。
- 修法：中断路径不走终态单点；`done` 允许覆盖中断型 blocked。
修后 G5 **2/2 通过**。

## 4. 仍未解决（如实）

**mission 终态仍是 `cancelled`**：CLI 在任务失败后立即 `shutdown()` → 调度器 `cancel()` →
`finishMission("cancelled")` 先落库；治理停止的 `blocked` 随后被终态单点拒绝。
根因是"关闭流程先于治理停止落库"，属时序问题，本轮未改 CLI 的收口顺序。

其余：`permissionAsk` 映射遗留；边界停止输出状态仍 `cancelled`。

## 5. 验证

- G5：2/2 通过；
- 全量：`tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 真实复跑：目标 `consumedToolCalls: 1`、pauseReason 与缺口保留。
