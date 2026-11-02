# ADR-0192 图变更后自动重算 V（R134，2026-11-02）

- 状态：**已实现（判定逻辑有单测；运行时联动未做集成测试）**
- 来源：用户"自动重算 V"
- 相关：ADR-0191（图变更暂停）、ADR-0146（V 计算）、ADR-0144（证据失效）

## 1. 规则（保守）

图变更（注入/删除/修订/重连）发生后，若 mission 绑定了目标：

1. 先按当前映射/收据/裁决**重算 V** 并落盘（复用 `recomputeGoalPotential`）；
2. `shouldPauseForGraphChange` 判定：
   - **V 上升**（有要求失去证据）⇒ 暂停 + `requiresReplanning` + 证据缺口；
   - V 不变 / 下降 / 无法计算（null）⇒ **不新增暂停**（不打断正常推进）。

与 R133 的区别：不再"任何图变更都暂停"，而是以**V 是否上升**为准。

## 2. 验证

```
tests/core/goal-graph-change-decision.test.ts → 3/3
  V 上升 ⇒ 暂停；不变/下降 ⇒ 不暂停；null ⇒ 不暂停
tests/core --maxWorkers=2 → 471 files / 3646 tests 全通过
typecheck / lint / build → 全绿
```

## 3. 未完成（重要）

- **运行时联动没有集成测试**：只测了纯判定函数；`recomputeGoalPotential` → 状态写入 → gate 暂停
  这条链靠代码走查，未真实触发；
- 没有真实 mission 演练（需同进程注入图变更）；
- V 重算依赖现有映射/收据；图变更**不会**更新映射（删除被映射任务后，映射仍指向已消失的 id，
  重算把它当 `unverified` ⇒ V 上升 ⇒ 暂停——方向安全，但映射未清理）；
- 重算失败（契约/revision 不一致等）⇒ 直接返回，不暂停也不提示（静默）；
- 暂停后仍需用户/宿主处理 `requiresReplanning`，没有恢复流程。
