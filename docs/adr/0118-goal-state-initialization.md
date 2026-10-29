# ADR-0118 目标状态初始化：让 hydrate 第一次能还原（GOAL-02 R33）

- 状态：已采纳（状态初始化已接；组开始/结束仍未接）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R33、
  [GOAL02_END_TO_END_GAPS_2026-10-29](../reports/GOAL02_END_TO_END_GAPS_2026-10-29.md) 缺口 1
- 相关：ADR-0092（解析器）、ADR-0116（控制面）

## 1. 背景

R32 的静态核对定位了决定性缺口：`GoalModeStateStore` **没有任何写入方**，
因此 `GoalGateCache.hydrate` 恒在第三步 `state-missing`、`restoredCount=0`、解析器恒 `null`。

## 2. 变更（冻结）

`runtime.createGoalContract` 在契约落盘成功后：

1. 读一次已有状态；**已存在 ⇒ 不覆盖**（不重置累计组数/预算/暂停原因）；
2. 不存在 ⇒ 写一条**初始状态**：
   - `documentRevision: 1`、`contractRevision = contract.revision`、
     `ownerIdentifier` / `sourceRequestReference` 取契约原值（**不可被模型改写**）；
   - `gateSnapshot = new GoalDispatchGate(contract).createSnapshot()`（初始基线全零、未暂停）；
   - `requirementBases: []`、`lastPotentialValue: null`、`currentTaskGroupIdentifier: null`、
     `consumedToolCalls: 0`、`consumedCostUnits: 0`、`isExperimentClosed: false`；
3. 随后 `refreshGoalGateCache()`。

效果：契约 + 绑定 + 状态三者齐备且 revision 一致 ⇒ `hydrate` 可以 `restoreFromSnapshot`，
`resolve(mission)` 返回门禁（**仍受激活与强制开关约束**）。

## 3. 生产调用链（源码位置）

```
runtime.createGoalContract                      application-runtime.ts
├─ GoalContractStore.saveActivated（未激活拒绝）
├─ goalModeStateStore.read（已存在则不覆盖）
├─ GoalDispatchGate(contract).createSnapshot()   goal-dispatch-gate.ts
├─ goalModeStateStore.write(initialState)        goal-mode-store.ts
└─ refreshGoalGateCache → GoalGateCache.hydrate
   └─ binding → contract → state → revision 一致 → restoreFromSnapshot
```

## 4. 未完成（如实）

- **组开始/结束仍未接**：`beginTaskGroup` / `finishTaskGroup` 仍无调用者 ⇒ 状态**初始化后不再更新**
  （组数、V、预算、暂停原因都不会推进；`evaluateResume` 永远看不到"在途组"）。
- **契约 revision 变更不迁移状态**：新 revision 契约 + 旧状态 ⇒ `hydrate` 报 `revision-mismatch`
  （这是有意的 fail-closed，但没有迁移/重置入口）。
- **仍无激活/强制 CLI**：控制面只能由宿主代码调用。
- **未运行验证**：没跑过"初始化后 hydrate 还原成功""第二次 createGoalContract 不覆盖"
  "revision 变化 ⇒ 跳过"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
