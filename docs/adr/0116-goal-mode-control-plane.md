# ADR-0116 目标模式控制面最小入口（GOAL-02 R30）

- 状态：已采纳（宿主侧方法；**无 CLI/UI**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R30、
  [E_PHASE_CONSISTENCY_2026-10-29](../reports/E_PHASE_CONSISTENCY_2026-10-29.md) §2
- 相关：ADR-0092（解析器）、ADR-0093（恢复对账）、ADR-0094（激活）、ADR-0096（收据）

## 1. 背景

R29 自查确认：R3–R5 的接线**没有任何写入方** —— 没有代码创建契约、绑定 mission 或激活目标模式，
因此 `GoalGateCache` 在生产上恒为空、解析器恒 `null`。`saveActivated` 此前**只有定义**。

## 2. 变更（冻结）

`ApplicationRuntime` 新增四个宿主侧方法（**无 CLI、无 UI**）：

| 方法 | 行为 |
|---|---|
| `createGoalContract({contract, activation})` | 经 `GoalContractStore.saveActivated`；**未激活 ⇒ 抛 `task-sequence-permission-denied`**；成功后 `refreshGoalGateCache()` |
| `bindMissionToGoal({missionIdentifier, goalIdentifier})` | `GoalMissionBindingStore.bind`（**改绑仍须先解绑**）；成功后刷新缓存 |
| `unbindMissionFromGoal(missionIdentifier)` | 解绑 + 刷新缓存（返回 `didUnbind`） |
| `refreshGoalGateCache()` | 显式 `hybrid` 重算（返回 `GoalGateHydrationResult`，含跳过原因） |

约束不变：
- **默认不激活**：`activateGoalMode` 仍需认证用户显式调用；
- **不阻断**：`isGoalModeEnforcementEnabled` 缺省 false；
- 控制面**只写自己的存储**（契约/绑定），不写任务链、不派发。

## 3. 生产调用链（源码位置）

```
宿主代码（无 CLI）
├─ runtime.activateGoalMode(...)                 application-runtime.ts
├─ runtime.createGoalContract({contract, activation})
│  └─ GoalContractStore.saveActivated → resolveGoalModeActivation
│     └─ refreshGoalGateCache → GoalGateCache.hydrate
└─ runtime.bindMissionToGoal({...})
   └─ GoalMissionBindingStore.bind → refreshGoalGateCache
门禁解析（既有）
└─ goalDispatchGateResolver = (m) => isGoalModeActivated ? goalGateCache.resolve(m) : null
```

## 4. 未完成（如实）

- **没有 CLI/UI**：只有宿主代码能调用；普通用户仍无法开启目标模式。
- **未做资格校验**：`bindMissionToGoal` 不检查 mission 是否存在、契约是否已存在（存在性由调用方保证）。
- **缓存刷新是同步等待**：绑定多个 mission 时逐个刷新（未批量）。
- **强制模式仍未接**：`isGoalModeEnforcementEnabled` 仍缺省关，判定只观察。
- **未运行验证**：没跑过"未激活 ⇒ 拒绝建契约""绑定后解析器非 null""解绑后回到 null"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
