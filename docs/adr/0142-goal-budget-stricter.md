# ADR-0142 预算取更严：目标上限 × 任务预算（K11，2026-10-31）

- 状态：已采纳（门禁 + 缓存 + 运行时选项；单测通过）
- 来源：用户"继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K11
- 相关：ADR-0076（门禁）、ADR-0092（解析器）

## 1. 背景

卡 02 要求"沿用现有调用总预算和截止时间，**取更严边界**"。现状：
门禁只看**契约里的目标级上限**（`resourceLimits.maximumToolCalls`），
而仓内**没有任务/调度级总预算**（只有每个 worker 的 `maximumLoopIterations`）。
两者不联动 ⇒ 目标级上限可能比任务预算宽松（或反之），不符合"取更严"。

## 2. 设计（冻结）

1. **门禁**新增 `applyExternalBudgetLimit({maximumToolCalls, source})`：
   - 有效上限 = `min(契约上限, 外部上限)`（任一为 `null` 时取另一个；都空 ⇒ 无限制）；
   - 拒绝时 detail 写明"**取更严**"以及更严的一方（`目标预算` / `任务预算（值，来源 …）`）。
2. **缓存** `GoalGateCache` 接受 `externalToolCallBudget`，在 `hydrate` 还原门禁后注入。
3. **运行时选项** `missionToolCallBudget?: number | null`：
   传给缓存（`source: "runtime.missionToolCallBudget"`）。
4. **不持久化外部预算**：它属于运行时配置；重启后需重新注入，否则只剩目标级上限。

## 3. 调用链（源码位置）

```
ApplicationRuntimeOptions.missionToolCallBudget
└─ GoalGateCache({externalToolCallBudget})
   └─ hydrate ⇒ restoreFromSnapshot → gate.applyExternalBudgetLimit
      └─ assertDispatchAllowed：effective = min(契约, 外部) → budget-exhausted（注明取更严）
```

## 4. 运行证据

```
npx vitest run tests/core/goal-budget-stricter.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

覆盖：仅目标上限、外部更小（注明来源）、目标更小（外部不放松）、清除外部后回退、
契约无上限但有外部预算。

## 5. 未完成（如实）

- **外部预算仍需宿主注入**：没有从既有调度配置自动推导（`maximumLoopIterations` 是"每 worker 轮次"，
  语义不同，不能直接换算成工具调用总预算）；
- **不持久化**：重启后若不重新注入，门禁只剩目标级上限（预算会"变宽松"）；
- **只覆盖工具调用数**：`maximumCostUnits` / `maximumWallClockSeconds` 未与外部预算联动；
- **无集成测试**：运行时选项 → 缓存 → 门禁的整条链路未验证。

## 6. 验证状态

门禁的取更严逻辑：**已运行通过**（5 条单测）；运行时接线：`implemented-unverified`。
