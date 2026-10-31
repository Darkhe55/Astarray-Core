# ADR-0139 目标完成耦合（K7，2026-10-31）

- 状态：已采纳（**默认关**；纯判定有单测，运行时路径未集成测试）
- 来源：用户"继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K7
- 相关：ADR-0122（V）、ADR-0137（K2 映射）、ADR-0138（K1 提案）

## 1. 背景

此前 "mission 完成" 由调度器 `complete-mission` 决定 → `finishMission("done")`，
**完全不检查目标**；即使目标要求一条都没证据，也会判完成。用户描述要求
"直到目标完成才标记完成"。

## 2. 设计（冻结）

1. **开关**：`ApplicationRuntimeOptions.isGoalCompletionRequired`（**缺省 false**，不改变现有收口）。
2. **纯判定** `evaluateGoalCompletion({contract, state})`：
   - `isExperimentClosed` ⇒ `isApplicable:false`、`isAllowed:true`（关闭后目标不再治理收口）；
   - revision 不一致 / `requiresReplanning` / `pauseReason !== null` ⇒ 不通过；
   - 每条契约要求必须有 `valid` 依据且 `remainingContribution === 0`；
   - 缺失、非 valid、剩余量非 0、**多余依据**（不属于当前契约）⇒ 不通过；
   - `lastPotentialValue` 必须为 `0`（`null` 也不通过）。
   - **不宣称现实正确**：只表示"已枚举要求都有本地证据"。
3. **端口**：`missionCompletionGoalPort(missionId)`（运行时实现）：
   - 未绑定目标 ⇒ `isApplicable:false`（不参与）；
   - 契约/状态缺失 ⇒ 不通过并给原因；
   - 否则调用纯判定。
4. **收口**：`MissionOrchestrator.finishMission` 在 `status === "done"` 且端口存在时先问目标；
   不通过 ⇒ **降级为 `blocked`** + `onUserEscalation` 列出原因；**不会先判完成后回滚**。
   端口抛错 ⇒ 同样降级 blocked（宁可保守，不误判完成）。

## 3. 调用链（源码位置）

```
finishMission("done")                      mission-orchestrator.ts
└─ missionCompletionGoalPort(missionId)   ← runtime 提供（仅开关开启时装配）
   ├─ GoalMissionBindingStore.readGoalIdentifier
   ├─ GoalContractStore.read + GoalModeStateStore.read
   └─ evaluateGoalCompletion               goal-completion-requirement.ts
      └─ 不通过 ⇒ status = "blocked" + onUserEscalation
```

## 4. 运行证据

```
npx vitest run tests/core/goal-completion-requirement.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

覆盖：齐备 ⇒ 允许；revision 不一致/需重规划/已暂停 ⇒ 拒绝；缺依据/非 valid/剩余量/ V 非 0/未计算 ⇒ 拒绝；
多余依据 ⇒ 拒绝；实验关闭 ⇒ 不适用且不阻断。

## 5. 未完成（如实）

- **默认关**：开启前不影响任何现有 mission 收口；
- **没有集成测试**：端口在真实调度收口时的降级、升级文案、与 Git 集成顺序**未验证**；
- **依赖 K2 映射**：没有映射 ⇒ 要求永远 `unverified` ⇒ V≠0 ⇒ 开启后会**几乎阻断所有完成**，
  因此必须先有映射（K2 已就绪，但"谁来写映射"仍缺：宿主/规划器/UI）；
- **"完成"语义**：只保证"已枚举要求有证据"，与用户描述的"现实完成"仍有差距（卡明确要求不宣称）；
- **未处理"目标完成但任务链还有任务"**：两者同时满足才判 done（任务链 done 是前置）。

## 6. 验证状态

纯判定：**已运行通过**（5 条单测）；端口与收口降级：`implemented-unverified`。
