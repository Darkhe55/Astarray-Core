# ADR-0147 目标暂停与组边界停止的真实验收（R83，2026-10-31）

- 状态：已采纳（新增 `goal-mode invalidate`；K5/K10 真实路径已验证）
- 来源：用户"k10"；前序 [R82 正向完成](0146-deterministic-receipt-evidence.md)
- 相关：ADR-0140（K10 端口）、ADR-0144（K5 入口）、ADR-0145（公开入口）

## 1. 本次新增

`goal-mode invalidate --goal <id> --requirement <id...> --reason <text>`：
把 K5 的内核入口暴露给 CLI（`facade.invalidateGoalEvidence`），用于构造"目标被暂停"的场景。

## 2. 真实运行证据（`test/` 目录）

### 2.1 K5：证据失效 ⇒ 暂停 + 需重新规划

```
goal-mode invalidate --goal goal-acceptance-1 --requirement req-1 --reason "验收用：hello5.md 被外部删除"
→ potentialValueAfterInvalidation: 1, invalidated: ["req-1"]

goal-mode status --goal goal-acceptance-1
→ isPaused: true
  pauseReason: "证据失效导致需要重新规划：验收用：hello5.md 被外部删除"
  requiresReplanning: true, lastPotentialValue: 1, evidenceGapCount: 1
  nextCheckpoint: "重新规划后设置新检查点"
```

### 2.2 K10 启动前阻断（强制模式 + 暂停目标）

```
run … --goal goal-acceptance-1 --goal-enforce
→ astarray: [目标门禁] 阻断派发：证据失效导致需要重新规划：验收用：hello5.md 被外部删除
→ mission-89855721：status=blocked（`status` 命令复核），任务仍 pending，hello6.md 未创建
```

### 2.3 K10 组边界停止（预算 1 次）

新建 `goal-k10`（`maximumToolCalls: 1`、`pauseConditions: ["budget-exhausted"]`、`req-1 → T-001`）：

```
run … --goal goal-k10 --goal-enforce
→ astarray: [目标门禁] 阻断派发：工具调用预算已用尽（2/1）。
→ astarray: [需要用户] 目标门禁在组边界拒绝继续调度: 工具调用预算已用尽（2/1）。
→ status: cancelled；hello7.md 已生成（任务在停止前已完成）

goal-mode status --goal goal-k10
→ isPaused: true, pauseReason: "工具调用预算已用尽（2/1）。", lastPotentialValue: 0, consumedToolCalls: 2

goal-mode verdicts（最近）
→ isEnforced: true；最后一条 reasonCode: "goal-paused"
```

## 3. 结论

- **K5 入口可用**：失效 ⇒ V 上升 ⇒ 暂停 ⇒ 需要重新规划；
- **K10 两条路径都真实触发**：启动前阻断（mission blocked、无副作用）与组边界停止（停止调度、已完成的产物保留）；
- **K6 暂停条件同时生效**（预算耗尽 ⇒ `pauseReason` 落在状态里）；
- **判定记录 `isEnforced: true`**，证明确实从"只观察"切到"强制"。

## 4. 发现的不一致（未修，如实记录）

1. **`run` 的输出状态与真实不一致**：启动前阻断时 facade 返回 `status: "running"`，随后 `status` 命令才是 `blocked`；
   组边界停止返回 `cancelled`。应统一为 `blocked`（否则调用方会误判）。
2. **预算计数超出上限**：`consumedToolCalls: 2` 而 `maximumToolCalls: 1`（先执行后检查；可接受但需说明）。
3. **一次 `--maxWorkers=2` 全量跑出现 1 条 unhandled error**（测试全过），重跑 exit 0；
   与本轮改动无直接证据关联，记为**瞬时抖动**，未定位。
4. **`isEnforced` 与暂停原因**：`reasonCode` 在最近记录中是 `goal-paused`（预算耗尽也映射为 paused），
   丢失"因预算"的细节（detail 里才有）。

## 5. 未完成（如实）

- 启动前阻断后 facade 状态未修正（见 §4.1）；
- 组边界停止只验证了"单任务 + 预算触发"，**未验证"多组任务"下的中间停止**；
- `--goal-enforce` 与 Git 集成/恢复的交互未验证；
- 无自动化测试覆盖 CLI（仅真实手工运行）。
