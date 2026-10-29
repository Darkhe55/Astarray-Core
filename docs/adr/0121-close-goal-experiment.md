# ADR-0121 关闭目标实验：停止新增目标派发（GOAL-02 R36）

- 状态：已采纳（关闭入口 + 门禁跳过 + 状态可见）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R36
- 相关：ADR-0118（状态）、ADR-0120（判定记录）

## 1. 背景

`GoalModeStateStore.closeExperiment` 早已实现（置 `isExperimentClosed` / `closedAtIso` /
`pauseReason`，**保留**任务、历史、限制与已执行结果），但**没有调用方** ⇒ 实验无法关闭。

## 2. 设计（冻结）

1. `runtime.closeGoalExperiment({goalIdentifier, reason})`：
   `closeExperiment` → `refreshGoalGateCache()`，返回 `{isExperimentClosed, closedAtIso}`。
2. **关闭的效果是"不再还原门禁"**：`GoalGateCache.hydrate` 遇到 `state.isExperimentClosed`
   即跳过，并记录新原因 **`experiment-closed`** ⇒ `resolve(mission)` 返回 `null`
   ⇒ **不再新增目标派发**（解析器只影响目标模式的参与，不撤销任何任务）。
3. **不删除任何东西**：契约、绑定、状态、历史、判定记录全部保留；`goal-mode status` 显示
   `closedGoalCount` / `closedGoalIdentifiers`，并注明"关闭后不再还原门禁"。

## 3. 生产调用链（源码位置）

```
runtime.closeGoalExperiment                       application-runtime.ts
├─ GoalModeStateStore.closeExperiment            goal-mode-store.ts
└─ refreshGoalGateCache → GoalGateCache.hydrate   goal-gate-cache.ts
   └─ state.isExperimentClosed ⇒ issue reason "experiment-closed"（不还原）
      ⇒ resolver 返回 null ⇒ 目标模式不再参与派发
CLI goal-mode status：closedGoalCount / closedGoalIdentifiers
```

## 4. 未完成（如实）

- **只影响目标门禁**：不会停止已在跑的 mission 或撤销任务；"停止新增目标派发"指的是
  目标模式不再对派发做判定（而不是杀掉现有工作）。
- **没有"重新开启"入口**：关闭是单向的（重新开启需要新契约 + 新状态，当前无此流程）。
- **关闭不写判定记录**：关闭动作本身只改状态文件（判定记录只在观察派发时产生）。
- **未运行验证**：没跑过"关闭后 hydrate 跳过""状态显示已关闭""关闭不改任务"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
