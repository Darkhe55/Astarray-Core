# F 阶段一致性自查（2026-10-29，R39）

> 目的：核对 R30–R38 的台账描述与源码事实；修正**已过期**结论；把仍缺项分为
> **可闭合 / 需产品决定 / 本窗口无法闭合**。**本检查点不改代码**，仅文档。

## 1. 逐项核对（检索证据）

| 能力 | 台账声明 | 源码事实 | 判定 |
|---|---|---|---|
| 控制面四方法 | R30 已接 | `createGoalContract` / `bindMissionToGoal` / `unbindMissionFromGoal` / `closeGoalExperiment` 均为 runtime 内 `const`，经 `ApplicationRuntime` 暴露 | ✅ |
| 状态初始化 | R33 | `createGoalContract` 内 `goalModeStateStore.read` → 不存在则 `write(initialState)`；**已存在不覆盖** | ✅ |
| 组开始/结束 | R34 | `goalTaskGroupBeginPort` / `goalTaskGroupFinishPort` 由编排器调用（`runLoop` / `maybeFinishGoalTaskGroup`） | ✅ |
| 判定落盘 | R35 | runtime **总是**装配 `onGoalDispatchVerdict` → `journal.record` → 再转回调 | ✅ |
| 关闭实验 | R36 | `closeGoalExperiment` → `closeExperiment` → 刷新；`hydrate` 以 `experiment-closed` 跳过 | ✅ |
| **V 计算** | R37 报告写"**未接**" | **已被 R38 推翻**：`assessGoalRequirementsFromLocalState`（2 处）+ `computeGoalPotential`（2 处）+ `recordGroupCompletion`（2 处：定义/调用）+ `recordToolCallConsumed`（2 处） | ✅ **已接**（R38） |
| 强制模式 | R37 写"无入口" | `isGoalModeEnforcementEnabled` 仅构造选项（3 处：类型/注释/传参），**无 CLI/config** | ❌ 仍缺 |
| 激活入口 | R30 写"仅宿主" | `activateGoalMode` 是 runtime `const`，**无 CLI/UI 调用** | ❌ 仍缺 |
| 重新开启 | R36 写"单向" | 无 reopen 方法；新 revision 会 `revision-mismatch` | ❌ 仍缺 |
| 组标识持久 | R37 写"进程内递增" | `task-group-<n>` 由 `goalTaskGroupCounter` 生成 | ❌ 仍缺 |

## 2. 台账需修正之处

1. `GOAL02_CLOSURE_RECOMMENDATIONS_2026-10-29.md` §2.1 的"V 计算未接"**已过期**（R38 已接），
   本检查点在该文件追加"更新"说明，不改写原结论（保留决策历史）。
2. GOAL-02 卡需补记 R38/R39，并注明"V 已接、强制/激活/重开仍缺"。

## 3. 仍缺项归类

**可闭合（代码层，后续轮次可做）**
- `groupKind` 区分（调查/返工 vs 普通）—— 影响停滞计数的准确性；
- 组标识持久化 —— 跨重启对账定位；
- 判定记录的导出/轮转。

**需产品决定**
- 强制模式与激活的**入口形态**（宿主启动配置 vs CLI 命令）；
- 重新开启的迁移规则（重置 vs 继承）；
- 是否允许"只观察"长期作为默认。

**本窗口无法闭合**
- 运行时行为验证（口径：不运行测试/验收）；
- 真实目标场景下的 V 校准（需要真实任务与证据）。

## 4. 验证状态

**静态核对**（检索命令见 §1）；**未运行任何代码**；本轮**无代码改动**。
