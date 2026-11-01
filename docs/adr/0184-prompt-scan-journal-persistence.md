# ADR-0184 扫描记录持久化与只读查看（R125，2026-11-01）

- 状态：**已实现并真实跑通**（真实 mission 写盘 → CLI 读回）
- 来源：用户"1"（PLAN_STATUS §B6）
- 相关：ADR-0103/0104（注入侧扫描）、ADR-0134（有界/轮转口径）

## 1. 问题

`prompt-scan-journal` 之前只在进程内环形缓冲（100 条），进程退出即丢；
事后无法回答"某次注入前上下文是否检查过"。

## 2. 设计

1. `PromptScanJournalStore`（`<state>/prompt-scan-journal.json`）：
   - 只记录**结论字段**（mission / agent / task / outcome / 规则版本 / 命中规则 / 时间），**不含正文**；
   - 有界（默认 100）；挤出最旧计入 `droppedRecordCount`（不静默消失）；
   - 原子写 + 备份恢复；损坏读回空文档。
2. 运行时装配**接收器**（`setPromptScanJournalSink`）：记录写入内存环形缓冲的同时
   异步落盘；接收方吞错（诊断不阻断装配/派发）。
3. CLI `scan-records [--recent N] [--json]`：只读查看（总数 / 丢弃数 / 上限 / 最近记录）。

## 3. 真实证据

```
真实 mission：mission-1afe51bc（读取任务，status done）
state/prompt-scan-journal.json → records=1, dropped=0

scan-records --recent 3 --json
→ totalCount=1, droppedRecordCount=0, maximumRecords=100
  recent[0]: mission=mission-1afe51bc task=T-001 outcome=clean clean=true
```

## 4. 验证

```
tests/core/prompt-scan-journal-store.test.ts → 2/2（追加读回；超上限挤出+计数）
tests/core --maxWorkers=2 → 471 files / 3629 tests 全通过
typecheck / lint / build → 全绿
```

## 5. 未完成

- 落盘是 **fire-and-forget**：进程在写入前退出会丢最后一两条；
- 没有轮转（达到上限后只保留最近 100；丢弃计数在，但不保留历史文件）——
  与判定记录的"归档 JSONL"口径不同；
- 没有按 mission/task 过滤的查询；
- 没有 UI 展示；
- 接收器是**全局单例**（同一进程多状态目录只会写最后一个装配的存储）。
