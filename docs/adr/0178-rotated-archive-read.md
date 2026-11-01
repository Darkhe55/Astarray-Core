# ADR-0178 轮转归档的只读读取（R118，2026-11-01）

- 状态：已采纳（判定导出与违规查看都读轮转文件；单测 + 真实 CLI 验证）
- 来源：用户"继续"（PLAN_STATUS §B4：`--include-archive` 不读轮转文件）
- 相关：ADR-0134（判定归档轮转）、ADR-0173（违规归档轮转）

## 1. 问题

判定记录与违规归档都会轮转为 `.1`…`.N`（越旧数字越大），但只读入口只读**主文件**，
溢出后旧记录在导出/查看里"消失"。

## 2. 设计

`readRotatedJsonlLines({archivePath, rotationCount?})`：

- 从**最旧**（`.N`）读到**次新**（`.1`），最后读主文件（最新）；
- 缺失文件跳过、空行忽略；
- 返回 `{lines, filesRead}`（`filesRead` 便于排查"到底读了哪些文件"）。

接入两处：
- `goal-mode verdicts --include-archive --export`（判定 JSONL 导出）；
- `goal-mode violations --include-archive`（违规查看）。

## 3. 验证

```
tests/core/rotated-jsonl-reader.test.ts → 2/2
  .2→.1→主文件顺序、空行忽略；只有主文件也能读、filesRead 正确。

真实 CLI（test/state 夹具）：
  goal-mode violations --goal goal-viol --include-archive --json
  → persistedCount=1, archivedCount=2（主文件 + .1 都被读到）

tests/core --maxWorkers=2 → 471 files / 3614 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- `rotationCount` 缺省只读 2 份（与保留份数一致），更旧的文件不读；
- 判定导出**不标注**每条来自哪个文件（`filesRead` 未进入输出）；
- 违规归档按目标过滤仍未做（归档条目里没有 goalIdentifier）。
