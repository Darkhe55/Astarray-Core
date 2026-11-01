# ADR-0173 不变量违规归档轮转（R112，2026-11-01）

- 状态：已采纳（轮转 + 保留 2 份 + 单测）
- 来源：用户"继续"；ADR-0168/0169 遗留"归档无轮转"
- 相关：ADR-0168（归档）、ADR-0120（判定记录归档口径）

## 1. 设计

- `GOAL_INVARIANT_ARCHIVE_MAXIMUM_LINES = 5000`、`GOAL_INVARIANT_ARCHIVE_RETENTION_COUNT = 2`；
- `rotateInvariantViolationArchiveIfNeeded({archivePath, maximumLines?, retentionCount?})`：
  - 行数未超上限 ⇒ 不动；
  - 超限 ⇒ 现有 `.1`→`.2`（保留数内后移），原文件→`.1`，原路径清空，超出保留数的文件删除；
- 运行时在**发生归档追加**之后调用（正常路径零开销），失败忽略（诊断不阻塞业务）。

## 2. 验证

```
tests/core/goal-invariant-archive.test.ts → 2/2
  未超上限 ⇒ rotated=false、内容不变；
  超限 ⇒ 原文件变 .1（6 行）、新文件空、旧 .1 顺移 .2、.3 被删。
tests/core --maxWorkers=2 → 471 files / 3606 tests 全通过（一次 unhandled 瞬时，重跑 exit 0）
typecheck / lint / build → 全绿
```

## 3. 未完成

- 轮转只在"有归档追加"时触发：如果归档已超限但之后没有新的丢弃，不会主动整理；
- 上限/保留数是常量，不可按目标配置；
- 读取入口（`goal-mode violations --include-archive`）**只读主归档文件**，不读 `.1`/`.2`；
- 真实超过 5000 行的演练未做（只有单测）。
