# ADR-0161 不变量违规列表有界（R98，2026-11-01）

- 状态：已采纳（有界 + 单测）
- 来源：用户"继续推进任务卡"；ADR-0160 引入"列表无上限"风险
- 相关：ADR-0143（K4）、ADR-0160（持久化）、ADR-0120（判定记录有界）

## 1. 问题

R97 把不变量违规写入目标状态且**没有上限**：长跑目标会持续增长状态文件。

## 2. 设计

- `GOAL_INVARIANT_VIOLATION_LIMIT = 200`；
- `appendBoundedInvariantViolation(existing, violation, limit)`：超过上限只保留**最近**的记录；
- 运行时写状态时使用该函数；与判定记录（有界 200）口径一致。

## 3. 验证

```
tests/core/goal-invariant-violation.test.ts → 6/6
  新增：两条旧记录 + 一条新记录、上限 2 ⇒ 只留最近两条（b, c）。
tests/core --maxWorkers=2 → 471 files / 3596 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- 被丢弃的记录**不归档**（与判定记录不同：判定有归档文件，违规没有）；
- 上限是常量，不可按目标配置；
- 真实长跑未演练。
