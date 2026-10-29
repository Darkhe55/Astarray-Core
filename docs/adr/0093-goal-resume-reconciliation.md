# ADR-0093 恢复前的目标模式对账（GOAL-02 R4）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R4
- 相关：ADR-0077（目标持久化）、ADR-0092（门禁解析器）、ADR-0064（恢复就绪分类）

## 1. 背景

`GoalModeStateStore.evaluateResume` 早已实现"在途组 ⇒ 先对账、暂停 ⇒ 保持暂停"，
但 **`resumeMission` 从未调用它**。结果：目标模式即使有持久化状态，恢复时也**不会被拦**，
可能直接重跑在途组（重复副作用）。

## 2. 设计（冻结）

1. **可选端口**：`MainControllerOptions.missionGoalResumeReconciliation?`
   （`(missionId) => Promise<{outcome: "resume" | "reconcile-first" | "stay-paused"; detail; evidenceGaps?}>`）。
   缺省不传 ⇒ 行为与接线前逐字一致。
2. **执行顺序**（`resumeMission` 内）：
   幂等守卫 → 只读恢复门禁（04-02）→ **目标模式对账（本步）** → 就绪分类（04-03）→ 租约 → 启动。
3. **运行时实现**：
   - mission **未绑定**目标 ⇒ `resume`（不参与）；
   - 绑定但**契约缺失/非法** ⇒ `stay-paused`（拒绝在无契约状态下续接）；
   - 有状态 ⇒ `evaluateResume`：`reconcile-first`（在途组）/ `stay-paused`（暂停/需重规划）/
     `resume` 原样映射。
4. **失败方向**：非 `resume` ⇒ `resumeMission` 抛 `mission-locked`，消息含 outcome、detail
   与证据缺口；**不启动调度器、不重跑任务**。
5. **只读**：本层不写目标状态、不改任务链、不派发。

## 3. 生产调用链（源码位置）

```
MainController.resumeMission                     packages/core/src/orchestration/main-controller.ts
├─ activeOrchestrators 幂等守卫
├─ missionRecoveryGate（可选）
├─ missionGoalResumeReconciliation（本步）        ← application-runtime 提供实现
│  ├─ GoalMissionBindingStore.readGoalIdentifier
│  ├─ GoalContractStore.read（缺失 ⇒ stay-paused）
│  └─ GoalModeStateStore.evaluateResume
├─ projectMissionResumeReadiness（04-03）
└─ 租约 → launchAssistMission / launchDevolveMission
```

## 4. 未完成（如实）

- **生产上仍不会触发**：没有写入方创建契约/绑定/状态（R3 缺口未变）⇒ 运行时实现恒返回 `resume`。
- **激活校验仍未接**：`resolveGoalModeActivation` 仍无调用方（R5）。
- **对账后的动作未接**：`reconcile-first` 只拒绝恢复，**没有**"对账后继续"的后续流程。
- **未运行验证**：没跑过"在途组 ⇒ 拒绝""未绑定 ⇒ 放行""契约缺失 ⇒ 拒绝"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
