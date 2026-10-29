# ADR-0117 `goal-mode status` 只读视图（GOAL-02 R31）

- 状态：已采纳（只读 CLI；**无写命令**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R31
- 相关：ADR-0092（解析器）、ADR-0116（控制面）

## 1. 背景

R30 让目标模式第一次有写入方，但**无法观察**：契约/绑定是否落盘、能还原几个门禁、
为什么跳过 —— 只能读 JSON 文件或猜。

## 2. 设计（冻结）

`goal-mode status [--json]`：

1. 读 `<state>/goal-mode/contracts/`（`GoalContractStore.list()`，非法/损坏自动跳过）；
2. 读 `<state>/goal-mode/mission-bindings.json`（`GoalMissionBindingStore.list()`）；
3. 用 `GoalGateCache.hydrate()` **只读重算**一次，报告 `restoredCount` 与按原因分组的
   `skippedByReason`（`contract-missing` / `contract-invalid` / `state-missing` /
   `revision-mismatch` / `restore-failed`）。

**明确不提供写命令**：创建契约、绑定 mission、激活目标模式都只能由宿主代码调用。
输出固定两条注意：
- 激活状态属**运行时内存**，CLI 无法得知；未激活时解析器恒 `null`；
- 强制模式仍缺省关（`isGoalModeEnforcementEnabled`），当前只观察不阻断。

## 3. 生产调用链（源码位置）

```
cli.tsx goal-mode status
└─ executeGoalModeStatusCommand                packages/tui/src/cli/goal-mode-command.ts
   ├─ GoalContractStore.list
   ├─ GoalMissionBindingStore.list
   └─ GoalGateCache.hydrate（只读重算；不写状态）
```

## 4. 未完成（如实）

- **看不到激活状态**：属于运行时内存，CLI 无法判断当前进程是否已激活（会误导为"未激活"吗？
  输出已显式说明"无法得知"，不猜）。
- **hydrate 是只读但会分配门禁对象**：不落盘，但每次 CLI 调用都重算一遍（成本未测）。
- **不显示契约内容**：只计数，避免把预算/截止等细节暴露到终端（可后续加 `--json` 明细）。
- **未运行验证**：没跑过"无契约无绑定 / 有绑定可还原 / revision 不一致跳过"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
