# ADR-0115 两套记账的一屏只读汇总（E 阶段收尾 R28）

- 状态：已采纳（只读汇总；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R28
- 相关：ADR-0108（索引）、ADR-0111/0113（队列）、ADR-0114（提案）

## 1. 背景

到 R27 为止，判断"这一单两套账到底怎么样"要分别跑：`status`（差异）、`--propose-writeback`、
`--deferred-insertions`。四类信息分散，人工核对容易漏项（尤其"历史被截断"这种低频信息）。

## 2. 设计（冻结）

`task-ledger status --mission X --summary`（缺 sequence/owner 用 R21 索引补全）一次输出：

1. **差异**（`inspectAlignment.divergences`）；
2. **写回提案**（`buildWriteBackProposal`，含条目数 + `isExecutable`）；
3. **待消费推迟插入**（按 mission 过滤的 `pending`）；
4. **已消费历史截断**（`droppedConsumedCount` / `lastDroppedAtIso`）。

约定：
- **只读**：不写文件、不改状态、不派发；
- 退出码：有差异/提案/待办/丢弃 ⇒ **仍然 0**（报告不是错误）；取数失败（mission 不存在、
  快照失败）⇒ **2**；
- JSON：`status: "attention" | "clean"`，其余字段原样嵌套。

## 3. 生产调用链（源码位置）

```
cli.tsx task-ledger status --mission --summary
└─ executeTaskLedgerStatusCommand              packages/tui/src/cli/task-ledger-command.ts
   ├─ TaskLedgerBridge.inspectAlignment
   ├─ TaskLedgerBridge.buildWriteBackProposal
   └─ DeferredInsertionQueueStore.read（pending 过滤 + 丢弃计数）
```

## 4. 未完成（如实）

- **不判断"该先做哪一步"**：只汇总，不给优先级建议。
- **不产出可持久化报告**：只在终端；没有写文件选项。
- **`--task` 与 `--summary` 同时给**时以 `--task`（预检）为准，未做互斥校验。
- **未运行验证**：没跑过"有差异/全干净/取数失败"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
