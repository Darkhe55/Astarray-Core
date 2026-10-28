# ADR-0052 派发循环去假值：真实占用、原子领取与"第二调度器"发现（ALIGN-02-05）

- 状态：部分采纳（假值已删、领取原语已交付；真实派发端点未接）
- 日期：2026-10-28
- 来源：[ALIGN-02](../tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md) 检查点 05
- 相关：ADR-0013（偏序集）、ADR-0049（序列先于 mission）、ADR-0051（单元选择）

## 1. 背景（实测）

装配层此前写死两处假值：

```ts
const dispatchRegistry = new UnboundedAgentInstanceRegistry({
  maxConcurrentSlots: 4, maxQueueLength: 32,
  currentOccupiedSlots: () => 0,          // 永远"有空槽"
});
const secondaryDispatchLoop = new SecondaryContinuousDispatchLoop({
  registry: dispatchRegistry,
  dispatchChain: async () => false,       // 永远"没人要"
  currentOccupiedSlots: () => 0,
});
```

后果：① 并发准入永远放行（`maxConcurrentSlots` 形同不存在）；
② `runRound` 的"未被接受"无法区分"执行方拒绝"与"根本没接执行方"；
③ `runRound` 从未被任何生产代码调用 —— 这个循环其实是**第二套调度器**，
而真正的执行由 `MissionOrchestrator` 内部的 `dagScheduler.scheduleRound()` 驱动。

## 2. 本轮改动（已落地）

1. **真实占用**：`UnboundedAgentInstanceRegistry` 新增
   `getOccupiedSlotCount()`（`running` 实例数）并作为 `currentOccupiedSlots` 的**缺省值**；
   装配层不再注入 `() => 0`。
2. **准入单一来源**：循环不再自行"占用 ≥ 上限就排队"，排队/暂停完全交给注册表
   （避免两套判定漂移）。
3. **派发端口按 mission 注册**：`registerMissionPorts(missionId, {dispatchChain, claimTask, releaseTask})`；
   构造函数的 `dispatchChain` 仅作为默认端口。**未注册处理器时 `runRound` 返回
   `blockedReason: "dispatch-handler-missing"`**，不领取、不伪装成"派发被拒"。
4. **原子领取 + 失败释放**：
   - `TaskSequenceManageController.claimTask`：`pending → running`，用序列 revision
     乐观并发；竞态/状态不符 ⇒ 返回 `false`（不重试、不抢占）⇒ 同一任务不会被派两次；
   - `releaseClaim`：`running → pending`；派发被拒或抛错时循环调用它，
     并释放准入（`releaseAdmission`），**不留假槽位**；
   - `skippedReasons` 逐任务给出原因（不再静默跳过）。
5. **派发入参带实例标识**：`DispatchChainInput.agentInstanceId`，执行方收口后必须回收该实例
   —— 否则真实占用不会回落（正好是"假槽位"的反面约束）。

## 3. 生产调用链（源码位置）

```
mission 启动方（尚未接线）
└─ SecondaryContinuousDispatchLoop.registerMissionPorts                 packages/core/src/orchestration/secondary-continuous-dispatch-loop.ts
runRound({ nodes, missionIdentifier })
├─ ports 缺失 ⇒ blockedReason "dispatch-handler-missing"（不领取）
├─ TaskSequencePartialOrder.getReadyTaskIds()                           只读 ready set
├─ registry.createInstance / requestAdmission                           资源准入（真实占用）
├─ ports.claimTask → TaskSequenceManageController.claimTask             原子领取（revision 乐观并发）
├─ ports.dispatchChain({taskIds, priorityTier, agentInstanceId})        执行方
└─ 失败 ⇒ releaseTask(→pending) + registry.releaseAdmission             不丢任务、不占槽位
```

## 4. 发现与未完成（如实）

- **没有真实派发端点**：`MissionOrchestrator` 没有"按 taskId 领取并派发"的公开 API，
  它用内部 `dagScheduler.scheduleRound()` 自行决策。硬把它接成
  `dispatchChain` 会用错语义（`reassignTask` 是"退回重试"，不是派发）。
- **因此循环仍不会真正驱动任务**：`registerMissionPorts` 目前无生产调用方；
  `claimTask`/`releaseClaim` 也还没有生产调用者。
- **两套记账未合并**：权威序列里的 `task-<missionId>` 与 mission 任务链
  （`T-001` 等）没有同步；序列任务会一直停在 `pending`，而 mission 实际在跑。
  这需要"编排器从序列领取"或"mission 链成为序列的投影"（02-05 后半 / 02-06）。
- 未做端到端：没有跑过"领取 → 派发失败 → 释放 → 再领取"的实测；未跑并发竞态。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
**不宣称**"派发链路已接通"或"并发约束已生效"。
