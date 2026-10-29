# ADR-0122 本地 V 计算接入组边界（GOAL-02 R38）

- 状态：已采纳（V 计算已接；强制仍关）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R38、
  [GOAL02_CLOSURE_RECOMMENDATIONS_2026-10-29](../reports/GOAL02_CLOSURE_RECOMMENDATIONS_2026-10-29.md) §2.1
- 相关：ADR-0119（组边界）、ADR-0120（判定记录）

## 1. 背景

`computeGoalPotential` 与 `GoalDispatchGate.recordGroupCompletion` 都存在，但**没有调用方**：
门禁的进展/停滞/预算分支永不触发，V 永远是初始值。

## 2. 设计（冻结）

1. 新增 `assessGoalRequirementsFromLocalState`：把**本地真实状态**映射成要求评估
   - 要求已映射任务节点，且**全部 done**、且**每个都有 accepted 独立裁决**
     ⇒ `valid`（`evidenceKind: "independent-acceptance"`，引用 `task-ledger:<tasks>`）；
   - 未映射节点 ⇒ `unverified`（写明原因）；
   - 部分未完成/缺裁决 ⇒ `unverified`（列出缺口节点）。
   - **不读模型输出、不做模糊匹配**。
2. 运行时在**组结束**（`goalTaskGroupStatePort.finish`）：
   - 读 mission 链真实状态、每个 done 任务的 accepted 裁决、完成收据的 `toolCallCount`；
   - `computeGoalPotential` 得 V（`status !== "computed"` ⇒ **不写伪 V**）；
   - 门禁实例可用时：`recordToolCallConsumed(收据增量)` + `recordGroupCompletion({groupKind:"normal", recordedBy:"local-verifier", potentialValueAfterGroup: V})`；
   - 用新 `createSnapshot()` + 逐项 `remainingContribution` 调 `finishTaskGroup` 落盘。
3. 失败一律降级为"只清在途标记"（不写伪 V、不推进组数），**不影响任务收口**。

## 3. 生产调用链（源码位置）

```
MissionOrchestrator.maybeFinishGoalTaskGroup         mission-orchestrator.ts
└─ goalTaskGroupFinishPort → runtime.goalTaskGroupStatePort.finish
   ├─ MissionManager.getMissionStatus（真实状态）
   ├─ CompletionVerdictStore.read / CompletionReceiptStore.read
   ├─ assessGoalRequirementsFromLocalState            goal-requirement-assessment.ts
   ├─ computeGoalPotential                            goal-contract.ts
   ├─ GoalDispatchGate.recordToolCallConsumed / recordGroupCompletion
   └─ GoalModeStateStore.finishTaskGroup（新 snapshot + requirementBases + V）
```

## 4. 未完成（如实）

- **`groupKind` 恒为 `normal`**：调查/返工组无法区分 ⇒ 停滞计数会把它们也计入。
- **只在组结束时算 V**：运行中不更新；`checksSinceLastReduction` 每 3 组才检查一次。
- **暂停只落状态**：到阈值会 `pause()`，但**强制模式仍关** ⇒ 只影响判定记录与状态，不阻断派发；
  也没有用户可见的"已暂停"提示（只有 `goal-mode status` 的 `pauseReason`）。
- **V 依赖裁决与收据齐备**：任一任务缺 accepted 裁决 ⇒ 对应要求 `unverified` ⇒ V 不降。
- **未运行验证**：没跑过"全 requirements 满足 ⇒ V 降""缺裁决 ⇒ 不降""门禁不可用 ⇒ 只清标记"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
