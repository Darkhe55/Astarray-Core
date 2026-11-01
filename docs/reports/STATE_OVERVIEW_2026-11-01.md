# 仓库状态总览（2026-11-01）

> 只读盘点。工作区里**他人/用户的未提交文件原样保留**（见 §5），本文件不处理它们。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `f585b6c2`（`feat(core): align a single-node sequence by whole mission`） |
| 与远端 | `ahead=0`（已推送） |
| 近期提交 | R118 轮转归档可读 → R119 台账更正 → R120 写回引擎 → R121 写回 CLI → R122 整 mission 对齐 |
| 全量测试 | **471 files / 3623 tests 全通过**（`--maxWorkers=2`） |
| 其它门禁 | `typecheck` / `lint` / `build` 全绿 |

## 2. 本轮（R101–R122）完成的能力

| 轮 | 内容 | 证据 |
|---|---|---|
| R101 | 完成控制事件提示核查（无缺陷） | 全量 + 真实补跑 |
| R102 | 多组预算停止 + 组边界 | 真实 mission `c6b13c65` |
| R103 | 只读任务的确定性证据 | 真实 mission `90bc56fb` |
| R104 | 停滞暂停（预置历史 + 真实组） | 真实 + 强制阻断 |
| R105–R107 | GOAL-02 卡收口、违规归档、只读查看 | 卡 + ADR-0168/0169 |
| R108–R111 | 强杀恢复闭环（组/任务对账、续接图修复、测试） | 真实闭环 + 单测 |
| R112–R113 | 归档轮转、调度器指令门面 | 单测 |
| R114 | rework 组性质真实演练 | trace 三段证据 |
| R115 | 完成事件缺失有界重试 | 真实 `9d01d418` done |
| R116 | 真实 12+ 组停滞（无预置） | 4 次 mission、14 组、暂停 |
| R117 | GOAL-02 最终交付报告 | 报告 + 0 死链 |
| R118 | `--include-archive` 读轮转文件 | 单测 + 真实 CLI |
| R119 | 台账 §B 两项按现状更正 | 文档 |
| R120 | 写回提案应用引擎（批准 + revision 双校验） | 单测 4/4 |
| R121 | `task-ledger apply-writeback` CLI + 夹具端到端 | 单测 2/2 |
| R122 | 整 mission 节点对齐（真实数据可用） | 单测 7/7 + 真实写回 |

ADR：0145–0181；`PLAN_STATUS` 记录到 **194**；GOAL-02 卡已收口（R117）。

## 3. 仍缺（按优先级）

1. **两套记账的持久 id 映射表**：当前靠 `externalReference` + "序列单节点"形态推断；
   多节点序列仍会误报（ADR-0181 §5）。
2. **§B1 按 taskId 真正派发**：结构性缺口（ADR-0052/0110），未做。
3. **§B3 `investigation` 组信号**：无本地客观信号（设计如此）。
4. **§B6 扫描记录持久化/UI**：`prompt-scan-journal` 仍进程内环形缓冲。
5. 写回：批准无身份校验、批量非原子、无 `--dry-run`、`needs-human-review` 仍人工。
6. 归档：读取只读 2 份轮转；归档不按目标过滤。
7. 测试稳定性：负载下偶发瞬时失败（各自单跑/重跑通过），未归因。

## 4. 产品/平台边界（未变）

- 不宣称"永不偏航"或现实世界正确；
- REMOTE-01 真实投递仍平台阻塞；
- 强制模式/激活入口仅宿主可调用。

## 5. 工作区未提交文件（**用户所有，未被我暂存**）

```
 M docs/tasks/B6R-11-COVERAGE-SPRINT.md
 M docs/tasks/NEXT60_PLAN_2026-10-29.md
 M docs/tasks/RESUME02_EXPERIMENTAL_SMART_CONTINUATION.md
?? docs/tasks/ARCHIVE_REVIEW_2026-10-30.md
?? docs/tasks/ARCHIVE_REVIEW_2026-11-01.md
?? docs/tasks/archive/completed-checkpoints/B6R-11-COVERAGE-SPRINT.md
?? docs/tasks/archive/completed-checkpoints/NEXT60_PLAN_2026-10-29.md
```

这些是此前就存在的改动/归档移动；本次总览**未修改、未提交**它们。需要我处理时请逐项指定（提交/丢弃/移动）。

## 6. 建议下一步

1. 持久 id 映射表（让多节点序列的写回/派发可用）；
2. §B6 扫描记录持久化 + 只读入口；
3. 或先决定 §5 那批文件的归属，再继续。
