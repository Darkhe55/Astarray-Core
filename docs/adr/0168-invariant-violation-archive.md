# ADR-0168 不变量违规丢弃归档（R106，2026-11-01）

- 状态：已采纳（分区函数 + 归档写入 + 单测）
- 来源：用户"继续任务"；ADR-0161 遗留"丢弃不归档"
- 相关：ADR-0160（持久化）、ADR-0161（有界 200）、ADR-0120（判定记录归档）

## 1. 问题

违规列表有界（200）后，被挤出的旧记录**直接丢弃**，与判定记录（有归档文件）不一致；
越权事实不应无声消失。

## 2. 设计

1. `partitionInvariantViolations(existing, violation, limit)`：返回 `{kept, dropped}`；
2. 运行时写状态时使用 `kept`，把 `dropped` 以 JSONL **追加**到
   `<state>/goal-mode/invariant-violations-archive.jsonl`；
3. 归档失败**不阻塞**违规记录（与既有"诊断不阻断业务"一致，但写状态仍继续）。

## 3. 验证

```
tests/core/goal-invariant-violation.test.ts → 7/7
  新增：两条旧 + 一条新、上限 2 ⇒ kept=[b,c]、dropped=[a]。
tests/core --maxWorkers=2 → 471 files / 3601 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- 归档文件**没有读取/查询入口**（`goal-mode` 命令暂不展示归档内容）；
- 归档无轮转/保留策略（会无限增长，与判定记录归档的 `maximumArchiveLines` 不同）；
- 归档写入是 fire-and-forget（失败只忽略，不重试）；
- 真实超过 200 条的演练未做（只有分区单测）。
