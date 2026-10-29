# GOAL-02 收口报告：剩余缺口与开关建议（2026-10-29，R37）

> 目的：把 F 阶段（R30–R36）之后仍然缺的东西写清，并对"强制模式/激活/V 计算/重新开启"
> 给出**建议**（不是已实现）。**本文件不含代码改动**，所有结论都带源码证据。

## 1. 已接线的部分（R30–R36）

| 能力 | 证据 |
|---|---|
| 控制面（建契约/绑定/解绑/刷新） | `runtime.createGoalContract` / `bindMissionToGoal` / `unbindMissionFromGoal` / `refreshGoalGateCache` |
| 状态初始化 | `createGoalContract` 首次写 `PersistedGoalModeState` |
| 组开始/结束 | `goalTaskGroupBeginPort` / `goalTaskGroupFinishPort` → `beginTaskGroup` / `finishTaskGroup` |
| 判定落盘 | `GoalDispatchVerdictJournal`（有界 200）+ runtime 总是装配 `onGoalDispatchVerdict` |
| 关闭实验 | `runtime.closeGoalExperiment`；hydrate 以 `experiment-closed` 跳过 |
| 只读观察 | `goal-mode status` / `goal-mode verdicts` |

## 2. 剩余缺口（源码证据）

### 2.1 V 计算未接（**最关键**）

检索结果：

- `GoalDispatchGate.recordGroupCompletion(` **只有定义、零调用方**；
- `GoalDispatchGate.recordToolCallConsumed(` **只有定义、零调用方**；
- 仓内**没有** `computePotentialValue` / `local-goal-*` 之类的本地 V 计算器。

后果：
- `completedGroupCount` / `checksSinceLastReduction` / `lastPotentialValue` / `consumedToolCalls`
  永不变化；
- `assertDispatchAllowed` 的**进展/停滞/预算**分支在生产上**永不触发**；
- 门禁实际只剩"契约 revision / 项目范围 / 截止时间 / 暂停标记"这类**静态**判定。

### 2.2 强制模式没有入口

`isGoalModeEnforcementEnabled` 只来自 `ApplicationRuntime` 构造选项（`application-runtime.ts:421`），
没有 CLI、没有配置文件、没有运行期开关 ⇒ 生产上恒 `false`，判定**只观察**。

### 2.3 激活没有用户入口

`activateGoalMode` 只能由宿主代码调用（R30）；CLI 进程**无法**改变已运行进程的内存激活状态。
`goal-mode status` 也明确写"激活状态属运行时内存，CLI 无法得知"。

### 2.4 重新开启路径缺失

`closeExperiment` 单向；新契约（`supersedesRevision`）虽有字段，但没有"关闭后重新开启"的流程，
且新 revision 的状态会以 `revision-mismatch` 被跳过（fail-closed）。

### 2.5 组标识不持久唯一

`task-group-<n>` 是进程内递增；重启后从 1 开始，可能与旧组同名（旧组已清空，但不可追溯）。

## 3. 开关建议（需要产品决定）

| 开关 | 建议 | 理由 |
|---|---|---|
| **强制模式** | **不提供 CLI 开关**，只在宿主配置里可用，并要求显式 `--goal-mode-enforce` 启动参数 | 阻断派发是高影响动作；CLI 子命令无法影响已运行进程，容易造成"以为开了其实没开" |
| **激活** | 同强制模式：**宿主启动配置**（一次性），不给独立的 `goal-mode activate` 命令 | 同上；且激活必须带"认证用户 + 显式请求"两事实，CLI 无法证明 |
| **V 计算** | **先做本地 V（逐 requirement 依据）再谈强制** | 没有 V 就没有进展/停滞判定，强制模式只剩静态拦截，收益低风险高 |
| **重新开启** | 需要**新契约 + 新状态迁移**流程；迁移规则（重置 vs 继承）必须产品决定 | 直接复用旧状态会以 `revision-mismatch` 失败；静默继承会掩盖"目标已换" |
| **组标识** | 若后续要跨重启对账，需持久化组标识（当前不满足） | 否则 `reconcile-first` 无法定位具体在途组 |

## 4. 能在本仓库闭合 / 需要产品决定

**可闭合（代码层）**：V 计算接入点（`recordGroupCompletion` 的调用方）、组标识持久化、
判定记录的导出/轮转。

**需要产品决定**：强制模式与激活的**入口形态**（CLI 还是宿主配置）、重新开启的迁移规则、
是否允许"只观察"长期作为默认。

## 5. 验证状态

**静态核对**（上述检索与文件位置为证）；**未运行任何代码**；本轮**无代码改动**。

## 更新（R38/R39，2026-10-29）

- **§2.1 "V 计算未接" 已过期**：R38 已接（[ADR-0122](../adr/0122-local-potential-in-group-boundary.md)）——
  `assessGoalRequirementsFromLocalState` → `computeGoalPotential` → `recordGroupCompletion` /
  `recordToolCallConsumed` → `finishTaskGroup` 落盘；`recordGroupCompletion` 与
  `recordToolCallConsumed` 现在各有生产调用方。
- **仍缺**（不变）：强制模式/激活无用户入口、无重新开启路径、组标识不持久、`groupKind` 恒 normal。
- 详见 [F_PHASE_CONSISTENCY_2026-10-29](../reports/F_PHASE_CONSISTENCY_2026-10-29.md)。
