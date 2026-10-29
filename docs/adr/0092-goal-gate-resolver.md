# ADR-0092 目标门禁解析器：契约存储 + mission 绑定 + 同步缓存（GOAL-02 R3）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R3
- 相关：ADR-0076（门禁）、ADR-0077（持久化）、ADR-0082（只读接线）

## 1. 背景

`MainController.observeGoalDispatchGate` 已调用 `goalDispatchGateResolver`，但**没有任何宿主提供它**
⇒ 生产上目标门禁不产生判定。R2 只装配了状态存储，仍缺三样东西才能"按 mission 还原门禁"：

1. 目标**契约**落盘（门禁需要契约里的 scope/预算/截止）；
2. mission → 目标的**绑定**（解析器的输入是 mission）；
3. 解析器本身——但 `goalDispatchGateResolver` 是**同步**签名，而三个输入都在磁盘上。

## 2. 设计（冻结）

1. **契约存储**（`goal-contract-store.ts`）：`<state>/goal-mode/contracts/<goal>.json`，
   写入前 `validateGoalContract`，非法拒绝落盘；读取时非法/损坏返回 `null`（不伪造契约）。
2. **mission 绑定**（`goal-mission-binding-store.ts`）：`<state>/goal-mode/mission-bindings.json`；
   一个 mission 只能绑定一个目标，**改绑需先显式解绑**（防止靠换目标绕过暂停）；
   解绑只删映射、不改历史。
3. **同步缓存**（`goal-gate-cache.ts`）：启动时 `hydrate()` 读绑定 → 契约 → 状态 →
   `GoalDispatchGate.restoreFromSnapshot`，之后 `resolve(mission)` 同步返回。
   **还原条件缺一不可**：绑定 / 契约存在且合法 / 状态存在 / 契约 revision 与状态一致；
   任一不满足 ⇒ **不还原**（解析器返回 `null`）并记录原因（`contract-missing` /
   `state-missing` / `revision-mismatch` / `restore-failed`）。
4. **失败方向**：不确定就不参与 —— 解析器返回 `null` 时 `observeGoalDispatchGate` 行为与接线前一致。
5. **默认只观察**：`isGoalModeEnforcementEnabled` 仍未传（缺省 false）⇒ 判定只记录/流式输出，
   **不阻断派发**。
6. **只读**：本层**不**创建契约、**不**绑定 mission、**不**写状态。

## 3. 生产调用链（源码位置）

```
ApplicationRuntime 构造                     packages/core/src/application/application-runtime.ts
├─ GoalContractStore / GoalMissionBindingStore / GoalModeStateStore
├─ GoalGateCache.hydrate()  （启动时一次；空目录 ⇒ 0 条）
└─ MainController 选项：goalDispatchGateResolver = (mission) => goalGateCache.resolve(mission)
   └─ launchAssistMission / launchDevolveMission
      └─ observeGoalDispatchGate → gate.assertMissionDispatchAllowed → onGoalDispatchVerdict
         └─ isGoalModeEnforcementEnabled=false ⇒ 只记录，不阻断
```

## 4. 未完成（如实）

- **没有写入方**：没有控制面 API/CLI 创建契约或绑定 mission ⇒ 生产上缓存恒为 0 条，
  解析器恒返回 `null`（**行为与接线前一致**，但这也意味着"已接线"目前只是插槽）。
- **缓存不失效**：绑定/契约变更后需重启或手动 `hydrate()`；没有自动刷新/订阅。
- **恢复路径未接**：`resumeMission` 仍未调用 `evaluateResume`（R4）。
- **激活校验未接**：`resolveGoalModeActivation` 仍无调用方（R5）。
- **未运行验证**：没有跑过"有绑定+契约+状态 ⇒ 还原成功""revision 不一致 ⇒ 跳过"
  "空目录 ⇒ 0 条且行为不变"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
