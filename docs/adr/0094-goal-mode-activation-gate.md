# ADR-0094 目标模式激活成为唯一开关；删除死常量（GOAL-02 R5）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R5、
  [GOAL_MODE_DEFAULT_CONSTANT_DECISION_2026-10-29](../reports/GOAL_MODE_DEFAULT_CONSTANT_DECISION_2026-10-29.md) 方案 A
- 相关：ADR-0075（契约）、ADR-0092（解析器）、ADR-0093（恢复对账）

## 1. 背景

`GOAL_MODE_DEFAULT_ENABLED = false` 全仓**仅定义处 1 次**，`resolveGoalModeActivation`
不读它 ⇒ "默认关闭"没有任何代码保证，常量只造成审计误导。决策记录给出 A/B 两案；
用户未另行指示，**按计划采用 A**（删除常量、保留激活判定）。

## 2. 变更（冻结）

1. **删除** `GOAL_MODE_DEFAULT_ENABLED`；
2. `resolveGoalModeActivation` 成为**唯一开关**：来源必须是 `user`、请求者已认证、
   显式用户请求、显式开启 —— 四者同时成立才 `isActive: true`；
3. **契约创建受激活约束**：`GoalContractStore.saveActivated(contract, activationInput)`
   先判定，未激活 ⇒ 抛 `task-sequence-permission-denied`，**不落盘**；
4. **运行时激活状态**：`runtime.activateGoalMode(input)`（唯一入口，经上述判定）与
   `runtime.getGoalModeActivation()`（只读）。**默认未激活**；
5. **门禁解析器受激活约束**：未激活 ⇒ `goalDispatchGateResolver` 恒返回 `null`
   ⇒ 目标模式完全不参与派发/恢复（行为与接线前一致）。

## 3. 生产调用链（源码位置）

```
resolveGoalModeActivation                        packages/core/src/orchestration/goal-contract.ts
├─ GoalContractStore.saveActivated               goal-contract-store.ts（未激活 ⇒ 拒绝落盘）
└─ ApplicationRuntime.activateGoalMode           application-runtime.ts
   ├─ 置 isGoalModeActivated
   └─ goalDispatchGateResolver = (m) => isGoalModeActivated ? cache.resolve(m) : null
      └─ MainController.observeGoalDispatchGate（只观察；强制仍缺省关）
```

## 4. 未完成（如实）

- **没有 UI/CLI 调用 `activateGoalMode`**：目前只能由宿主代码调用；默认未激活。
- **契约/绑定仍无写入方**：`saveActivated` 与 `bind` 都没有生产调用者 ⇒ 生产上缓存恒 0 条。
- **强制模式仍关**：`isGoalModeEnforcementEnabled` 缺省 false，判定只记录不阻断。
- **未运行验证**：没跑过"未激活 ⇒ 解析器 null""模型来源 ⇒ 拒绝激活"
  "未激活 ⇒ 拒绝创建契约"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
