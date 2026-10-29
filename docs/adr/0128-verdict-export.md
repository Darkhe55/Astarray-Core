# ADR-0128 判定记录的只读导出（GOAL-02 R53）

- 状态：已采纳（只读导出；不改保留策略）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R53、ADR-0120
- 相关：ADR-0117（`goal-mode status`）

## 1. 背景

R35 的判定记录有界 200 条、只能通过 `goal-mode verdicts` 在终端看最近 N 条。
要做离线审计/比对（例如"某次阻断发生在什么时候"），需要一个可带走的文件格式。

## 2. 变更（冻结）

`goal-mode verdicts --export <path>`：

1. 读源存储（`<state>/goal-mode/dispatch-verdicts.json`），把**存储中保留的全部记录**
   写成 **JSONL**（每行一条，字段与存储一致）；
2. **只读源**：不改保留策略、不清空、不轮转；
3. 空记录 ⇒ 写空文件（不写"{}"）；
4. **导出失败**（路径为空/不可写）⇒ stderr 提示 + **退出码 2**，不谎报成功；
5. `--json` 时输出 `{status:"exported", exportPath, exportedCount, droppedRecordCount, note}`；
6. **丢弃的历史不可恢复**：输出里明确写 `droppedRecordCount`。

## 3. 生产调用链（源码位置）

```
cli.tsx goal-mode verdicts --export <path>
└─ executeGoalModeVerdictsCommand          packages/tui/src/cli/goal-mode-command.ts
   ├─ GoalDispatchVerdictJournal.read（只读）
   └─ fs.writeFile(exportPath, JSONL)
```

## 4. 未完成（如实）

- **不导出被丢弃的记录**：只有 `droppedRecordCount` 计数，内容早已不在（ADR-0120 的有界策略）。
- **不校验目标路径**：允许写到任意可写位置（包括本次工作区的非预期位置）；没有"仅限 state 目录"限制。
- **不是审计日志**：没有签名/哈希链，文件可被事后编辑。
- **未运行验证**：没跑过"有记录 ⇒ 导出 N 行""空记录 ⇒ 空文件""不可写 ⇒ 退出码 2"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
