# ADR-0159 组性质持久化（R96，2026-11-01）

- 状态：已采纳（状态 + 状态视图；单测通过）
- 来源：用户"继续推进任务卡"；卡 01/03 的"组标识/当前组"落盘要求
- 相关：ADR-0119（组开始/结束）、ADR-0126/0130（组性质）、ADR-0150（状态合并）

## 1. 问题

组开始/结束会写 `currentTaskGroupIdentifier`，但**组性质（normal/rework/investigation）没有落盘**：
重启后无法知道上一组是普通推进还是返工/调查，状态视图也看不到。

## 2. 设计

1. 状态新增可选 `lastTaskGroupKind`（旧状态缺失 ⇒ `null`，不推断）。
2. `finishTaskGroup` 接收 `groupKind` 并写入；合并逻辑仍以磁盘最新状态为基线，
   **保留** `pauseReason`/缺口/`requiresReplanning`/消耗。
3. `describeStatus` 返回 `lastTaskGroupKind`（CLI/SDK 状态视图可见）。

## 3. 验证

```
tests/core/goal-mode-store-group-kind.test.ts → 1/1
  finishTaskGroup({groupKind:"rework"}) ⇒ lastTaskGroupKind="rework"，暂停原因保留；
  describeStatus 同步可见。
tests/core --maxWorkers=2 → 471 files / 3594 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- 运行时已有组性质提供者（R61），但**真实 mission 未复跑**验证落盘值（仅单测）；
- 只有"最近一组"保留，没有历史列表；
- `beginTaskGroup` 不记录性质（性质在组开始时未知，合理）。
