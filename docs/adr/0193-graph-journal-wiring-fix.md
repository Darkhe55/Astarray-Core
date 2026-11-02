# ADR-0193 图变更接线修复与审计落盘时序（R135，2026-11-02）

- 状态：**修复完成**（真实 store 测试；真实 mission 演练受模型波动阻塞）
- 来源：用户"继续"（补 R134 的联动集成验证）
- 相关：ADR-0190（审计）、ADR-0191/0192（联动）

## 1. 演练中发现的两个真实问题

1. **审计/通知没有透传**：`MissionOrchestrator` 构造 `DagScheduler` 时只传了
   `concurrency/taskStore/allocateAgentId`，把 `graphChangeJournal` / `onGraphChanged` 丢在编排器选项里。
   真实注入时 trace 显示 `[GRAPH] inject T-99 journal=none` —— 审计与目标联动都不会发生。
2. **审计写入是 fire-and-forget**：即使接线正确，`injectTaskChecked` 返回后立刻读归档会读不到
   （测试首轮失败：expected [] to have length 1）。

## 2. 修复

- `MissionOrchestratorOptions` 增加 `graphChangeJournal` / `onGraphChanged`，并在构造 `DagScheduler`
  时**透传**；
- `recordGraphChange` 改为 `async`，四个图变更路径 `await` 它（append 失败仍吞错，不阻断变更）。

## 3. 验证

```
tests/core/task-graph-change-journal.test.ts → 2/2
  调度器注入 ⇒ 真实 store 落盘 1 条（inject，before=null，after.dependsOn=[]）；
  坏行跳过、只返回本 mission。
tests/core --maxWorkers=2 → 471 files / 3648 tests 全通过
typecheck / lint / build → 全绿
```

真实 mission 演练（`graph-drill.mjs`）：三次尝试中一次成功注入
（`mission-96395264`，`INJECT ok`），但该次跑在修复前 ⇒ `journal=none`；
修复后重跑遇模型任务连续失败（`T-01 failed/T-02 blocked`），未再拿到注入窗口。
**因此"真实 mission 联动"仍未验证**（见 §4）。

## 4. 未完成

- **真实 mission 的"图变更 → V 重算 → 目标暂停/不暂停"仍未端到端验证**；
  需要可控的慢任务或检查点暂停来制造安全点窗口；
- 演练脚本依赖真实 provider，模型不稳定时不可重复；
- 目标联动（onMissionGraphChanged → 状态写入）仍无独立测试，只有调度器通知 + 审计落盘有测试。
