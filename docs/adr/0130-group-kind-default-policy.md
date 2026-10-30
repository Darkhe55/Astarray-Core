# ADR-0130 `groupKind` 默认策略：只看本地可见的"返工"事实（R61，2026-10-30）

- 状态：已采纳（默认策略已接；`investigation` 仍无信号）
- 来源：用户选择继续第 1 项；[ADR-0126](0126-goal-group-kind.md)（接入点）
- 相关：ADR-0122（V）、ADR-0119（组边界）

## 1. 背景

R51 只给了接入点（`goalTaskGroupKindProvider`），**没有默认策略** ⇒ 生产未传 provider 时
所有组都记 `normal`，调查/返工组被计入停滞检查。

## 2. 设计（只看客观本地事件，不猜）

`MissionOrchestrator` 内部维护 `reworkedTaskIdentifiers`，只有两类事件会写入：

| 事件 | 位置 | 为什么算返工 |
|---|---|---|
| 主 Agent 指令 `retry` / `reassign` | `reassignTask()` | 同一任务被要求重做 |
| 早停续跑（缺失完成事件） | `handleWorkerOutcome` 的续跑分支 | 同一任务被再次执行 |

**默认判定**（宿主没有提供 provider 时）：

```
本次要启动的任务中，任一 taskId ∈ reworkedTaskIdentifiers ⇒ "rework"
否则 ⇒ "normal"
```

**刻意不做的事**：
- **不**根据任务标题、描述、模型自述判断（不可核对）；
- **不**产生 `investigation` —— 仓内**没有**"调查组"的本地信号，硬造一个只会在停滞计数上
  引入新的不可解释行为；
- 宿主仍可用 `goalTaskGroupKindProvider` 覆盖（R51 的入口不变）。

## 3. 调用链（源码位置）

```
MissionOrchestrator.reassignTask / 早停续跑          mission-orchestrator.ts
└─ reworkedTaskIdentifiers.add(taskId)
MissionOrchestrator.runLoop（组开始）
└─ startingTaskIdentifiers = 本次 start-task 的 taskId
   ├─ provider 存在 ⇒ 用它（抛错 ⇒ normal）
   └─ 否则 ⇒ 任一 ∈ reworkedTaskIdentifiers ? "rework" : "normal"
      └─ currentGoalTaskGroupKind → finishPort → recordGroupCompletion({groupKind})
```

## 4. 未完成（如实）

- **`investigation` 永远不会由默认策略产生**：需要先定义"调查组"的客观信号（例如独立的
  task type 字段），当前没有。
- **"返工"只覆盖两类事件**：`unblock` 后重跑不算返工（权限放行不是返工）；
  人工改派但未走 `reassignTask` 的路径也不会被记录。
- **集合只增不减**：同一 mission 内按任务数有界，但跨组会保留历史标记
  （同一任务后续正常组仍算 `rework`）。
- **未运行验证**：没跑过"retry ⇒ rework""早停续跑 ⇒ rework""普通组 ⇒ normal"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。

## 6. 更新（R62，2026-10-30）

§4 的"**未运行验证**"已部分过期：R62 把解析抽成纯函数 `resolveGoalTaskGroupKind` 并加了
6 个单测，**已运行通过（6/6）**；但**编排器接线、retry/早停写入集合、V/停滞行为仍未测**，
全量 `npm run test` 仍未运行。见 [ADR-0131](0131-group-kind-unit-test.md)。
