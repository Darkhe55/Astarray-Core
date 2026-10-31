# ADR-0141 暂停条件收窄为可评估枚举（K6，2026-10-31）

- 状态：已采纳（校验 + 评估 + 组结束接线；**行为变化：未知条件现在会被拒绝**）
- 来源：用户"继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K6
- 相关：ADR-0076（门禁）、ADR-0122（V）、ADR-0119（组边界）

## 1. 背景

`GoalContract.pauseConditions` 是**自由文本**：写进契约也没有任何代码读取/评估，
等于"声明了但永远不生效"。卡 02 已把这列为缺口（"`pauseConditions` 未评估"）。

## 2. 设计（冻结）

1. **有限枚举**（`goal-pause-condition-catalog.ts`）：
   - `budget-exhausted`（工具调用或成本达上限）
   - `deadline-passed`（超过契约截止时间）
   - `stagnation`（门禁连续检查 V 未下降达阈值）
   - `requires-replanning`（证据失效）
   未知字符串 **契约校验直接拒绝**（不允许"写了但没人看"）。
2. **评估**（`goal-pause-conditions.ts`，纯函数）：只评估**契约里已声明**的条件；
   返回 `{shouldPause, reasons, triggeredConditions}`，不做副作用。
3. **接线**（组结束，V 计算之后）：用**门禁实时计数**（`gate.getState()`）评估；
   触发 ⇒ `gate.pause(原因, 原因列表)`，随后快照/状态自然带上暂停原因。
4. **不改变**：门禁自身的停滞暂停逻辑（`recordGroupCompletion` 内已有）仍然生效；
   两者可同时触发，`pause()` 幂等（重复调用只更新原因）。

## 3. 调用链（源码位置）

```
组结束（runtime.goalTaskGroupStatePort.finish）
├─ computeGoalPotential → gate.recordGroupCompletion
├─ evaluateGoalPauseConditions({contract, state(实时计数), nowIso})
└─ shouldPause ⇒ gate.pause(reasons) → createSnapshot → finishTaskGroup 落盘
契约创建/变更：validateGoalContract 校验 pauseConditions 白名单
```

## 4. 运行证据

```
npx vitest run tests/core/goal-pause-conditions.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

覆盖：未声明 ⇒ 不暂停（即使预算耗尽）、budget（工具/成本）、deadline、stagnation、
requires-replanning、未知条件被契约校验拒绝、已知条件合法。

## 5. 未完成（如实）

- **行为变化**：以前可以写任意 `pauseConditions` 文本，现在会被拒绝 —— 仓内没有生产契约，
  属于设计收紧；如果未来要支持自定义文本，需要另加"说明字段"而不是复用该数组。
- **`maximumWallClockSeconds` 未评估**：状态里没有可靠的"目标开始时间"（`createdAt` 未持久化），
  因此只评估工具/成本两项；这是已知缺口。
- **没有集成测试**：组结束触发暂停、暂停后 `goal-mode status` 的展示、强制模式下的停止都未验证。
- **暂停不会自动恢复**：仍需要用户/宿主显式处理（与既有语义一致）。

## 6. 验证状态

纯评估与白名单校验：**已运行通过**（8 条单测）；运行时接线：`implemented-unverified`。
