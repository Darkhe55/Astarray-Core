# ADR-0144 证据失效的内核写入点（K5，2026-10-31）

- 状态：已采纳（纯状态变换 + 运行时入口 + 门禁同步；**检测器仍在外侧**）
- 来源：用户"继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K5
- 相关：ADR-0122（V）、ADR-0092（门禁）、ADR-0143（K4）

## 1. 背景

卡 02 要求："证据失效导致 V 上升时保留事实、暂停并重新规划，禁止修改权重掩盖倒退。"
门禁 `recordEvidenceInvalidation` 早已存在，但**零调用方**；也没有任何代码把"失效"写进持久状态。
同时，**"谁判定失效"在仓内没有检测器** —— 这是外部职责（文件变化、上游删除、契约变更等）。

## 2. 设计（冻结）

1. **纯变换** `buildInvalidatedGoalState({contract, state, requirementIdentifiers, reason, nowIso})`：
   - 只处理**契约中存在**的要求（未知 ⇒ 抛错，不静默忽略）；
   - 被点名的要求：`evidence.kind = "invalidated"` + 原因，`remainingContribution = weight`；
   - 用 `computeGoalPotential` **重算 V**（不手改数字）；存在 `unreliable` 谓词 ⇒ V 为 `null`（不给伪数字）；
   - 置 `requiresReplanning: true`、`pauseReason`、追加证据缺口；快照同步（`isPaused/requiresReplanning/lastPotentialValue`）；
   - `documentRevision + 1`、更新时间。
2. **运行时入口** `invalidateGoalEvidence({goalIdentifier, requirementIdentifiers, reason})`：
   - 契约/状态缺失 ⇒ `mission-not-found`；未知要求 ⇒ `invalid-task-chain`；
   - 写状态；
   - **同步所有已绑定 mission 的内存门禁**：V 可算 ⇒ `recordEvidenceInvalidation`（暂停 + 重规划 + 缺口）；
     V 不可算 ⇒ 只 `pause`（不伪造数字）。
3. **不删除旧事实**：旧 `valid` 依据被替换为 `invalidated` + 原因（保留"曾有效"的语义变化轨迹由文档缺口记录）。

## 3. 调用链（源码位置）

```
（外部检测器 →）runtime.invalidateGoalEvidence
├─ buildInvalidatedGoalState（纯变换 + 重算 V）
├─ GoalModeStateStore.write
└─ 每个绑定 mission：GoalGateCache.resolve → gate.recordEvidenceInvalidation / pause
```

## 4. 运行证据

```
npx vitest run tests/core/goal-evidence-invalidation.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

覆盖：只标记指定要求（其余保持 valid）、剩余量回权重、V 从 0 升到 2、暂停/重规划/缺口/快照、
未知要求抛错、`unreliable` ⇒ V 为 null 但仍暂停。

## 5. 未完成（如实）

- **仍无检测器**：没有文件监听、没有上游变更事件；"何时失效"必须由宿主/未来检测器调用本入口；
- **无集成测试**：运行时入口 → 状态落盘 → 门禁同步的整条链路未验证；
- **只按"要求粒度"失效**：不支持"某个任务节点的证据失效但要求仍部分成立"的细粒度；
- **旧证据不保留副本**：`invalidated` 覆盖原 `valid` 事实（原因保留，但原证据引用丢失）；
- **V 不可算时**只暂停、不记录数值（符合"unknown 优于伪精确"，但下游无法据此比较）。

## 6. 验证状态

纯变换：**已运行通过**（3 条单测）；运行时入口与门禁同步：`implemented-unverified`。
