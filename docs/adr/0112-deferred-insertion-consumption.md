# ADR-0112 组边界安全点消费推迟插入（两套记账收口 R25）

- 状态：已采纳（消费已接；**消费 ≠ 派发**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R25
- 相关：ADR-0111（队列）、ADR-0052（结构性缺口）

## 1. 背景

R24 让推迟插入进入持久队列，但**没有消费方**：队列只增，"下一组要消费"仍靠人记。
同时 `consumed` 无上限。

## 2. 变更（冻结）

1. `MissionOrchestratorOptions.taskGroupBoundaryPort?: () => Promise<void>`；
   在 `runLoop` 每轮开头、**`inFlightTaskIds.size === 0`**（安全点）时调用一次；
   抛错只 `onUserEscalation`，不中断调度。
2. 控制器实现：`consumeDeferredInsertions(missionIdentifier)`
   - 取该 mission 的 `pending`；
   - 逐条 `markConsumed({consumedByGroupIdentifier: "task-group-boundary"})`；
   - 成功后写差异快照（`trigger: "deferred-insertion-consumed"`）并 `streamOutput`；
   - 输出明确写"**消费 ≠ 派发**：任务已进权威序列，仍需下一组调度；运行中图变更仍不支持"。
3. `AssistScheduler` / `DevolveScheduler` 的选项是 `Omit<MissionOrchestratorOptions,…>`，
   `taskGroupBoundaryPort` 经 `super` 自然透传；控制器只在**装配了队列存储**时提供该端口。
4. `consumed` **有界**：缺省 200 条，超出丢弃最旧（`slice(-max)`），不影响 `pending`。

## 3. 生产调用链（源码位置）

```
MissionOrchestrator.runLoop                     packages/core/src/orchestration/mission-orchestrator.ts
├─ ensureGitIntegrationSession
├─ if (inFlightTaskIds.size === 0) taskGroupBoundaryPort()   ← R25
│  └─ MainController.consumeDeferredInsertions
│     ├─ DeferredInsertionQueueStore.listPending(mission)
│     ├─ markConsumed(..., "task-group-boundary")
│     └─ recordTaskLedgerDivergenceSnapshot(trigger: deferred-insertion-consumed)
└─ dagScheduler.scheduleRound()
```

## 4. 未完成（如实）

- **消费 ≠ 派发**：任务不会因此进入运行中图；`DagScheduler` 仍不支持图变更。
- **端口每轮都试**：无 pending 时是空操作，但每轮都会读一次队列文件（成本未测）。
- **组边界靠"无在途任务"近似**：不是严格的"组"概念（没有组标识）。
- **`consumed` 丢弃无告知**：超出 200 条时静默丢最旧，没有计数暴露。
- **未运行验证**：没跑过"有 pending ⇒ 移到 consumed""无 pending ⇒ 空操作""超 200 条 ⇒ 丢最旧"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
