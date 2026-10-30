# ADR-0136 内核缺口第一批：状态视图 / 失活 / 契约变更（K9+K8+K3，2026-10-30）

- 状态：已采纳（代码 + 单测；生命周期仍无真实 mission 验证）
- 来源：用户"开始补"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md)
- 相关：ADR-0116（控制面）、ADR-0121（关闭实验）、ADR-0118（状态初始化）

## 1. 背景

内核缺口报告把 K9（状态读取）、K8（失活/归档）、K3（契约变更）列为低/中量级缺口，
且这三个**不依赖缺失的信号源**（K4/K5/K6/K11 依赖尚不存在的违规/证据失效/预算信号）。
本次先补这三项。

## 2. K9 状态视图（`describeStatus` 首次有调用方）

- 运行时新增 `describeGoalStatus(goalIdentifier)`：委托 `GoalModeStateStore.describeStatus`；
  **无状态返回 `null`**（不伪造）。
- CLI 新增 `goal-mode status --goal <goal-id>`：
  - `--json` ⇒ `{status:"goal-status", goalStatus}`；
  - 无状态 ⇒ `goal-not-found` + **退出码 2**；
  - 文本输出固定包含 `稳定性保证: none` 并说明"本命令不提供、不宣称任何稳定性保证"。
- 这使 UI/宿主**第一次有唯一事实来源**（V、依据条数、缺口数、暂停原因、下一检查点）。

## 3. K8 目标失活（"移除"的安全语义）

- 运行时新增 `deactivateGoal({goalIdentifier, reason})`：
  1. `closeGoalExperiment`（置关闭标记，保留全部记录）；
  2. 遍历 binding，**解绑该目标的所有 mission**；
  3. 刷新门禁缓存（已关闭 ⇒ `experiment-closed` 不还原）。
- **不删除任何文件**：契约、状态、判定记录保留。语义是"不再参与派发"，
  符合卡 03"保留已存在任务和历史，不清除限制"。
- 返回 `{closedAtIso, unboundMissionCount}`。

## 4. K3 契约变更（合法性 + revision 规则）

新增纯函数 `validateGoalContractChange`（`goal-contract.ts`）与运行时 `updateGoalContract`：

校验规则（缺一即拒，返回具体原因）：
1. **来源**只能是 `source-publisher` / `authenticated-owner`；`model-proposal` / `tertiary-agent` 一律拒绝；
2. 新契约本身必须通过 `validateGoalContract`；
3. `goalIdentifier` / `ownerIdentifier` / `sourceRequestReference` **不可变**；
4. `revision` 必须**恰好 +1**；
5. `supersedesRevision` 必须等于被替代的 revision；
6. **总权重不变**（降权重 = 降判准）。

运行时 `updateGoalContract({contract, proposer, activation})`：
- 无现存契约 ⇒ `mission-not-found`；校验不过 ⇒ `task-sequence-permission-denied`（带原因）；
- 保存走 `saveActivated`（仍需激活）；
- 状态 revision 与当前契约不一致 ⇒ `journal-corrupted`（先对账）；
- **累计预算不重置**：保留 `consumedToolCalls` / `consumedCostUnits`；
- **V 依据作废**：`requirementBases: []`、`requiresReplanning: true`、写入证据缺口说明；
- 结束后刷新门禁缓存。

## 5. 运行证据

```
npx vitest run tests/core/goal-contract-change.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

覆盖：合法变更、模型提议被拒、revision 非 +1 被拒、supersedes 不指向上一版被拒、
更换 goal/owner/来源引用被拒、降低总权重被拒。

另：`npm run typecheck` 0、`npm run lint` 0、`npm run build` 成功；
`npx vitest run tests/core --maxWorkers=2` → **467 files / 3547 tests 全通过**（新增 6 条）。

## 6. 未完成（如实）

- **无真实 mission 验证**：K9/K8/K3 的运行时路径（解绑、刷新、状态写入）没有集成测试；
- **K8 不是硬删除**（卡要求保留历史，故刻意不删）；
- **K3 不迁移旧证据**（旧 revision 的依据直接作废，可能是保守但会暂时抬高 V）；
- **K4/K5/K6/K11 仍未做**：它们依赖尚不存在的信号源（不变量违规检出、外部证据失效检测、
  `pauseConditions` 结构化语义、任务总预算），需要先设计，不能"接线"了事；
- **K1/K2/K7/K10** 未动。

## 7. 验证状态

K3 的校验规则：**已运行通过**（6 条单测）；其余为 `implemented-unverified`。
