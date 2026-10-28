# ADR-0078 两套记账的只读对照与显式拒绝（接线缺口第 ① 项）

- 状态：部分采纳（对照 + 显式拒绝；派发/插入仍未实现）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ① 项
- 相关：ADR-0052（派发循环与占用）、ADR-0056（任务包信包）

## 1. 背景

已知结构性缺口：**权威任务序列**（`AgentTaskSequenceStore` / `TaskSequenceStatusController`）与
**mission 任务链**（`MissionManager` / `DagScheduler`）是两套记账；
`MissionOrchestrator` 没有"按 taskId 领取/派发/插入"的公开 API；`DagScheduler` 不支持运行中图变更。

在补上派发能力之前，先要能**在代码里表达**"两边差在哪"以及"当前缺什么能力"——
否则任何"已接线"的说法都无法被核对。

## 2. 契约（冻结）

1. **只读对照**（`TaskLedgerBridge.inspectAlignment`）：
   返回两边任务集合、`tasksOnlyInSequence`、`tasksOnlyInMission`、
   状态不一致列表（含两边状态）、`readyTaskIdentifiers`、可读的 `divergences` 摘要。
   **不改任何状态、不推进 revision、不派发**。
2. **能力如实登记**：报告里 `capabilities` 四个布尔字段**恒为 false**
   （`claimTaskByTaskIdentifier` / `dispatchTaskByTaskIdentifier` / `insertDuringRun` /
   `mutateTaskGraph`）—— 调用方不必猜。
3. **显式拒绝**：`requestDispatchByTaskIdentifier` / `requestInsertionByTaskIdentifier`
   返回 `kind:"refused-unsupported"` + `missingCapabilities` 清单，
   **不返回成功、不做静默 no-op、不伪造派发**。
4. **鉴权沿用既有口径**：对照经 `TaskSequenceStatusController.getSnapshot`，
   viewer 必须是序列 owner 或用户（不在本层另造权限）。
5. **装配共享 store**：状态控制面与管里面使用**同一个 `AgentTaskSequenceStore` 实例**，
   保证读到同一份序列文件（运行时已改）。

## 3. 生产调用链（源码位置）

```
MainController.inspectTaskLedgerAlignment              packages/core/src/orchestration/main-controller.ts
└─ TaskLedgerBridge.inspectAlignment                  task-ledger-bridge.ts
   ├─ TaskSequenceStatusController.getSnapshot       （共享 store；鉴权在控制器内）
   └─ MissionManager.getMissionStatus               （mission 任务链侧）
运行时装配
└─ application-runtime.ts：sequenceStore 抽出为变量，manage/status 两个控制器共用
```

## 4. 未完成（如实）

- **派发/插入仍未实现**：两个请求方法只返回拒绝；`DagScheduler` 图变更、单任务领取、
  序列→mission 的写入回同步都**没有**做。
- **没有自动对账**：对照是只读查询，不会修正任何一边；两套记账仍可能长期漂移。
- **没有 UI/CLI**：只能程序化调用 `inspectTaskLedgerAlignment`。
- **没有测试**：未跑"只在序列/只在 mission/状态不一致"三种差异。
- **视图受限**：对照需要调用方提供 `ownerAgentInstanceId` 与 `sequenceId`；
  mission 与序列的对应关系目前没有持久索引（属 ALIGN-04-01 的 relation index，尚未接这里）。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
