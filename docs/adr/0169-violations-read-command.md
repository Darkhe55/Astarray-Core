# ADR-0169 违规记录只读查看（R107，2026-11-01）

- 状态：已采纳（CLI 只读入口 + 真实状态文件验证）
- 来源：用户"继续任务"；ADR-0168 遗留"归档无读取入口"
- 相关：ADR-0160（持久化）、ADR-0168（归档）

## 1. 设计

`goal-mode violations --goal <id> [--recent N] [--include-archive] [--json]`：

- 读目标状态的 `invariantViolations`（持久）；
- `--include-archive` 时再读 `goal-mode/invariant-violations-archive.jsonl`（逐行 JSON，坏行跳过）；
- 输出持久/归档条数与最近 N 条（JSON 或文本）；
- **只读**：不改状态、不触发门禁。

## 2. 验证（真实状态文件）

```
seed: state/goal-mode/goal-viol.json（1 条持久违规）
      state/goal-mode/invariant-violations-archive.jsonl（1 条归档）
goal-mode violations --goal goal-viol --include-archive --json
→ persistedCount: 1, archivedCount: 1
  recentPersisted: [{ tool.permission-denied, "writeFile: 拒绝", … }]
  recentArchived:  [{ tool.permission-denied, "old: 归档条目", … }]
```

全量：`tests/core --maxWorkers=2` → **471 files / 3601 tests**；`typecheck`/`lint`/`build` 绿。

## 3. 未完成

- 归档**无轮转/保留策略**（会增长）；
- 无按目标过滤归档（归档文件是全局的，条目里没有 goalIdentifier）；
- 无自动化测试（本次为真实 CLI + 夹具验证）；
- 文本输出未做颜色/分页（与既有 CLI 一致：纯文本）。
