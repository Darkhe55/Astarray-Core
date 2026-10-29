# ADR-0119 目标组开始/结束的状态写入（GOAL-02 R34）

- 状态：已采纳（不推进 V；只维护在途组标记）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R34
- 相关：ADR-0118（状态初始化）、ADR-0112（组边界近似）

## 1. 背景

R33 让状态第一次被写入，但只是**初始快照**：
`beginTaskGroup` / `finishTaskGroup` 仍无调用者 ⇒ 在途组标记永远为空，
`evaluateResume` 看不到"在途组"，`gateSnapshot` 也永不变化。

## 2. 变更（冻结）

1. `MissionOrchestratorOptions` 新增：
   - `goalTaskGroupBeginPort({taskGroupIdentifier, startedAtIso})`
   - `goalTaskGroupFinishPort({taskGroupIdentifier, outcome, finishedAtIso})`
2. **开始**：一个调度轮里存在 `start-task` 动作、**无在途任务**且尚未开始时调用一次；
   组标识 `task-group-<n>`（进程内递增，**不是持久唯一标识**）。
3. **结束**：`inFlightTaskIds` 归零时调用一次（`success` ⇒ `completed`，其它 ⇒ `interrupted`）；
   端口失败只升级，不影响任务收口。
4. 运行时实现（`goalTaskGroupStatePort`）：
   - 只在该 mission **已绑定目标**、契约存在且 `state.contractRevision === contract.revision` 时写；
   - `begin` → `GoalModeStateStore.beginTaskGroup`（写 `currentTaskGroupIdentifier`）；
   - `finish` → `finishTaskGroup`，**`gateSnapshot` / `requirementBases` / V / 消耗原样回写**
     （**不推进 V、不累计组数**），仅清空在途标记并更新 `updatedAtIso`。
5. 控制器把端口按 mission 绑成闭包，透传给 assist/devolve 两个调度器。

## 3. 生产调用链（源码位置）

```
MissionOrchestrator.runLoop                     mission-orchestrator.ts
├─ scheduleRound → actions
├─ 有 start-task && 无在途 && 未开始 ⇒ goalTaskGroupBeginPort
└─ worker 完成后 inFlight 归零 ⇒ maybeFinishGoalTaskGroup ⇒ goalTaskGroupFinishPort
   └─ MainController.buildGoalTaskGroupPorts（按 mission 绑定）
      └─ runtime.goalTaskGroupStatePort
         ├─ GoalMissionBindingStore.readGoalIdentifier
         ├─ GoalContractStore.read + GoalModeStateStore.read（revision 一致才写）
         └─ beginTaskGroup / finishTaskGroup
```

## 4. 未完成（如实）

- **不推进 V**：`completedGroupCount`、`checksSinceLastReduction`、`consumedToolCalls` 都不变；
  `goalSnapshot` 因此与初始值一致 ⇒ **门禁的进展/停滞判定仍不会触发**。
- **组标识不持久唯一**：进程重启后计数从 1 开始（可能与旧组同名，但旧组已清空）。
- **`outcome` 只用于日志**：`finishTaskGroup` 接口未消费它（当前实现忽略）。
- **并行任务下的"组"是近似**：只要有任务还在跑就不结束；与"任务组"语义不完全一致。
- **未运行验证**：没跑过"开始写标记""归零清标记""revision 不一致跳过"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
