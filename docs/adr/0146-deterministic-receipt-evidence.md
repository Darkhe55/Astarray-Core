# ADR-0146 确定性判据证据与组结束顺序（R82，2026-10-31）

- 状态：已采纳（真实 mission 正向完成已验证）
- 来源：R81 复跑发现"正向完成做不到"（[acceptance §8](../reports/GOAL02_REAL_MISSION_ACCEPTANCE_2026-10-31.md)）
- 相关：ADR-0122（V）、ADR-0139（K7）、ADR-0137（K2）

## 1. 两个根因

1. **组结束早于任务落账**：`maybeFinishGoalTaskGroup` 在 `handleWorkerOutcome` **之前**调用，
   而 V 的本地评估读的是任务链持久状态 ⇒ 永远看到 `pending/running` ⇒ V 恒为 1。
2. **证据只认 accepted 裁决**：卡允许"确定性判据**或**独立验收"，但实现只用
   `CompletionVerdictStore` 的 accepted 裁决；单任务 CLI 流程不产生裁决 ⇒ 无法到 0。

## 2. 设计（冻结）

1. **顺序修正**（`mission-orchestrator`）：先 `handleWorkerOutcome`（把 done 写进任务链），
   再 `maybeFinishGoalTaskGroup`；失败路径同样先落结果、再结束组。
2. **确定性判据**（`goal-requirement-assessment`）：
   - 输入新增可选 `taskIdentifiersWithVerifiedReceipt`；
   - 当要求 `completionPredicateKind === "deterministic-check"` 且任务 **done + 验证收据**
     （`hasVerifiedCompletionControlEvent === true` 且 `artifactPaths.length > 0`）⇒ 记 0；
   - 证据来源**如实标注**：全部任务有 accepted 裁决 ⇒ `independent-acceptance`；
     否则 ⇒ `deterministic-check`（引用 `completion-receipt:<task>`）；
   - `independent-acceptance` 谓词仍**只**认裁决（收据不算）。
3. 运行时组结束把"验证收据任务集合"传给评估（与既有 receipt 读取同一循环）。

## 3. 真实运行证据（2026-10-31 19:19）

```
run --goal goal-acceptance-1 --goal-require-completion …
→ {"missionId":"mission-6ed57632","status":"done"}
goal-mode status --goal goal-acceptance-1
→ lastPotentialValue: 0, requirementBasisCount: 1, consumedToolCalls: 1, stabilityGuarantee: "none"
receipt: hasVerifiedCompletionControlEvent=true, artifactPaths=["hello5.md"], toolCallCount=1
workspace/hello5.md 内容正确
```

即：**V=0 且完成耦合放行**，这是目标驱动链路的第一次正向完成。

## 4. 单元测试

`tests/core/goal-receipt-evidence.test.ts`（4/4）：收据 ⇒ deterministic-check；
无收据无裁决 ⇒ unverified；`independent-acceptance` 谓词不认收据；有裁决 ⇒ 来源标为 independent-acceptance。
全量：471 files / 3588 tests 通过。

## 5. 未完成（如实）

- **"确定性判据"的强度有限**：只校验"收据 + 产物路径非空"，**未校验产物内容**是否符合要求描述；
- **artifactPaths 未做存在性复核**（评估是纯函数，不读盘）；
- **K10 组边界停止仍未实跑**（需要运行中暂停场景）；
- **accepted 裁决路径仍未跑过**（四层路由控制面未接 CLI）；
- 证据来源标注变了：以前一律 `independent-acceptance`，现在可能有 `deterministic-check`
  （下游若按证据类型统计需同步）。
