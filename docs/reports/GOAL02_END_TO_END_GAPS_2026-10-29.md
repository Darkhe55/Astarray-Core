# GOAL-02 端到端静态核对（2026-10-29，R32）

> 目标：核对"激活 + 绑定 + 契约 + 状态"四者齐备时的真实路径，产出**缺口清单**。
> 本文件是**静态核对**（读源码 + 检索），**未运行任何代码**。

## 1. 四要素各自的现状（源码证据）

| 要素 | 生产者 | 现状 |
|---|---|---|
| **契约** | `runtime.createGoalContract` → `GoalContractStore.saveActivated` | ✅ 有写入方（R30） |
| **绑定** | `runtime.bindMissionToGoal` → `GoalMissionBindingStore.bind` | ✅ 有写入方（R30） |
| **状态** | `GoalModeStateStore.write / beginTaskGroup / finishTaskGroup / closeExperiment` | ❌ **零调用方** |
| **激活** | `runtime.activateGoalMode` → `resolveGoalModeActivation` | ✅ 有入口（R5/R30），⚠️ **无 CLI/UI 调用** |

**决定性缺口**：状态存储**没有任何写入方**。

## 2. 门禁路径（派发前观察）

```
MainController.observeGoalDispatchGate                    main-controller.ts
├─ resolver = options.goalDispatchGateResolver
├─ gate = resolver(missionId)                             ← runtime: isGoalModeActivated ? cache.resolve(m) : null
├─ 若 gate === null ⇒ { isBlocked:false }（= 不参与）
├─ verdict = gate.assertMissionDispatchAllowed({...})
├─ record = GoalDispatchVerdictRecord
├─ isEnforced = isGoalModeEnforcementEnabled === true      ← 缺省 false
└─ onGoalDispatchVerdict(record)（**只回调，不落盘**）
```

`GoalGateCache.hydrate` 的还原条件（`goal-gate-cache.ts`）：
绑定存在 → 契约存在且合法 → **状态存在** → `state.contractRevision === contract.revision`
→ `restoreFromSnapshot`。任一不满足 ⇒ 跳过并记录原因。

因此即便 R30 写入了契约与绑定，hydrate 仍会在**第三步**返回 `state-missing`，
`restoredCount = 0`，`resolve` 恒 `null`，目标门禁**仍不参与派发**。

`runtime.createGoalContract` / `bindMissionToGoal` 都会 `refreshGoalGateCache()`，
所以缓存本身是新的 —— 缺的不是刷新，是**状态**。

## 3. 恢复路径（恢复前对账）

```
MainController.resumeMission
├─ activeOrchestrators 幂等
├─ missionRecoveryGate（可选）
├─ missionGoalResumeReconciliation（runtime 提供）
│  ├─ 未绑定 ⇒ resume
│  ├─ 契约缺失 ⇒ stay-paused
│  └─ evaluateResume(goalIdentifier, contract)
│     └─ 状态不存在 ⇒ { kind:"resume", detail:"没有持久化状态：按首次运行处理。" }
├─ projectMissionResumeReadiness
└─ 租约 → 启动
```

结论：**状态缺失时恢复一律放行**（"按首次运行处理"），这与"有状态才拦"的语义一致，
但也意味着 **`evaluateResume` 的拦截分支在生产上永远走不到**。

## 4. 缺口清单（按影响排序）

| # | 缺口 | 影响 | 可闭合性 |
|---|---|---|---|
| 1 | **状态无写入方**（`beginTaskGroup`/`finishTaskGroup` 无调用者） | 目标门禁**永不参与**；恢复对账的拦截分支**永不触发** | 可（需接编排器组边界） |
| 2 | **强制模式无入口**（`isGoalModeEnforcementEnabled` 只由 runtime 选项传） | 只能"观察"，无法真正阻断 | 可（CLI/宿主配置） |
| 3 | **激活无 CLI/UI** | 终端用户无法开启目标模式 | 可（但涉及产品决定） |
| 4 | **判定不落盘**（`onGoalDispatchVerdict` 仅回调） | 无法事后审计"某次派发为什么被放行" | 可（复用环形/JSON 存储） |
| 5 | `closeExperiment` 无调用方 | 实验关闭路径未接线 | 可（与 R33 一起） |

## 5. 下一步建议（R33 起）

1. **接状态写入**：在编排器组开始/结束处调用 `beginTaskGroup` / `finishTaskGroup`
   （这是缺口 1 的唯一解法，也让门禁第一次有 `gateSnapshot`）；
2. 判定记录持久化（缺口 4），复用 `prompt-scan-journal` 的环形模式；
3. 激活与强制的 CLI 入口（缺口 2/3）留到 E/F 阶段收尾统一决策。

## 6. 验证状态

**静态核对**（上述源码位置为证）；**未运行任何代码**；本轮**无代码改动**。
