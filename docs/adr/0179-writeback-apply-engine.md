# ADR-0179 写回提案的应用引擎（R120，2026-11-01）

- 状态：**引擎 + 控制器接线完成**（有单测；**无 CLI 入口**，见 §4）
- 来源：用户"继续"（PLAN_STATUS §B2：写回提案不可应用）
- 相关：ADR-0114（只读提案）、ADR-0110（单任务预检）

## 1. 设计

`TaskLedgerBridge.applyWriteBackProposal`（新增）：

- **只应用 `mark-sequence-done`**；其它动作（`needs-human-review` / `missing-*`）原样跳过并给出原因
  （不猜、不单向推导）；
- **必须人工批准**：`approvedBy` 非空、`approvedAtIso` 合法；
- **revision 双重防护**：`expectedSequenceRevision` 必须等于提案 revision，且等于**当前快照** revision，
  否则 `stale-revision`（防止旧提案覆盖新状态）；
- 每次迁移带当前 revision，走 `TaskSequenceStatusController`（审计条目由它追加）；
- 未装配写回端口 ⇒ 明确拒绝（不静默 no-op）。

`MainController.applyTaskLedgerWriteBack`：装配 `sequenceTransition`（使用 `TaskSequenceManageController.transitionTaskStatus`），
其余规则沿用。

## 2. 验证

```
tests/core/task-ledger-writeback-apply.test.ts → 4/4
  只应用 mark-sequence-done（T-02 跳过）；revision 不一致 ⇒ stale-revision；
  当前快照已变化 ⇒ stale-revision；缺批准/未装配端口 ⇒ 拒绝。
tests/core --maxWorkers=2 → 471 files / 3618 tests 全通过
typecheck / lint / build → 全绿
```

## 3. 未做（如实）

- **没有 CLI 入口**：`task-ledger apply-writeback` 未实现，只能由宿主/脚本调用控制器；
- **真实序列/真实 mission 的端到端演练未做**（只有端口级单测）；
- **`mark-sequence-done` 不检查下游依赖**（与提案口径一致：风险写在文本里）；
- 提案与批准之间**没有签名/身份校验**（`approvedBy` 只是字符串）；
- 批量应用**非原子**：逐条迁移，中途失败会留下已应用的部分（调用方需重生成提案）。
