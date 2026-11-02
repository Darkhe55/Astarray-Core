# ADR-0190 任务图变更审计（R132，2026-11-02）

- 状态：**已实现**（追加式 JSONL + 只读 CLI + 调度器集成）
- 来源：用户"2"（图变更历史）
- 相关：ADR-0187/0188/0189（修订/注入删除/重连）、ADR-0134（归档口径）

## 1. 设计

`TaskGraphChangeJournalStore`（`<state>/task-graph-changes.jsonl`，追加式）：

- 每条记录：`missionIdentifier / changeKind(inject|remove|revise|rewire) / taskIdentifier /
  recordedAtIso / before / after`；
- `before`/`after` 只含**结构字段**（dependsOn、description、toolNames），不含提示词正文；
- 注入的 `before` 为 null，删除的 `after` 为 null；
- 追加失败**不阻断**图变更（调度器吞错）；
- 读取按 mission 过滤，坏行跳过。

接线：`DagScheduler` 的 `graphChangeJournal?` 端口 → 控制器 → 运行时构造 store 并装配；
CLI `graph-changes --mission <id> [--json]` 只读查看。

## 2. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 12/12
  注入/重连各写一条；before/after 依赖正确；missionIdentifier 正确。
真实 CLI（夹具）：
  graph-changes --mission mission-demo --json
  → count=1, changeKind=rewire, before.dependsOn=[T-01], after.dependsOn=[]
tests/core --maxWorkers=2 → 471 files / 3642 tests 全通过
typecheck / lint / build → 全绿
```

## 3. 未完成

- 只在**调度器进程内**记录：如果图变更来自其它路径（如直接改链文件），不会入账；
- 无轮转/上限（追加式会一直增长），读取也不读 `.1` 等；
- 没有操作者身份（actor）字段——只记时间与结构；
- 没有 CLI 过滤（按 changeKind/时间）；
- 真实 mission 的图变更演练未做（runtime 未产生图变更，只有夹具验证）。
