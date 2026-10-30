# ADR-0126 组性质（groupKind）接入组边界（GOAL-02 R51）

- 状态：已采纳（机制已接；**没有默认实现**，缺省仍 `normal`）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R51、ADR-0122
- 相关：`goal-dispatch-gate.ts`（`GoalGroupKind` / 停滞计数）

## 1. 背景

R34/R38 让组边界写状态、算 V，但 `recordGroupCompletion` 的 `groupKind` **恒为 `normal`**：
调查组与返工组也会被计入停滞检查，连续 3 次 V 不降就 `pause()` —— 这是**误判风险**。

## 2. 变更（冻结）

1. `MissionOrchestratorOptions.goalTaskGroupKindProvider?`：
   `({taskIdentifiers}) => "normal" | "investigation" | "rework"`（**同步、无副作用**）。
2. 组开始时调用一次（只传本次 `start-task` 的任务标识），把结果记在 `currentGoalTaskGroupKind`；
   provider **抛错 ⇒ 保守按 `normal`**（不因诊断失败改变停顿语义）。
3. 组结束时把 `groupKind` 传进 `goalTaskGroupFinishPort`；运行时用它填
   `recordGroupCompletion({ groupKind })`，并保留 `outcome`（`completed`/`interrupted`）。
4. `MainController` 与 `ApplicationRuntime` 各加同名透传选项；**缺省不传 ⇒ 行为与 R34 一致**。

## 3. 生产调用链（源码位置）

```
MissionOrchestrator.runLoop                       mission-orchestrator.ts
└─ 有 start-task ⇒ goalTaskGroupKindProvider?.(taskIdentifiers) → currentGoalTaskGroupKind
   └─ maybeFinishGoalTaskGroup → goalTaskGroupFinishPort({groupKind, outcome})
      └─ MainController.buildGoalTaskGroupPorts → runtime.goalTaskGroupStatePort.finish
         └─ gate.recordGroupCompletion({groupKind, outcome, recordedBy:"local-verifier"})
```

## 4. 未完成（如实）

- **没有默认实现**：仓库里没有任何"如何判定调查/返工"的策略（也不该由模型自述决定）；
  生产上未传 provider ⇒ 仍然一律 `normal`，**误判风险未消除**，只是**有了接入点**。
- **provider 是同步纯函数**：不能查存储/读任务链（需要异步判断时要先改签名）。
- **没有运行验证**：没跑过"provider 返回 investigation ⇒ 不计停滞""抛错 ⇒ 回退 normal"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。

## 6. 更新（R61，2026-10-30）

本文 §4 的"**没有默认实现**"已过期：R61 增加了默认策略（只看 `retry`/`reassign`/早停续跑
三类客观事件 ⇒ `rework`，否则 `normal`；**不产生 `investigation`**），见
[ADR-0130](0130-group-kind-default-policy.md)。宿主 provider 仍可覆盖。
