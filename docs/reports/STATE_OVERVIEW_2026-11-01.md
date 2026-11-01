# 仓库状态总览（2026-11-01，R127 更新）

> 只读盘点。工作区里**用户/他人的未提交文件原样保留**（见 §5），本文件不处理它们。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `b79906ac`（`docs(status): mark the task dispatch backlog item as a bounded implementation`） |
| 与远端 | `ahead=0`（已推送） |
| 全量测试 | **471 files / 3633 tests 全通过**（`--maxWorkers=2`） |
| 其它门禁 | `typecheck` / `lint` / `build` 全绿 |
| ADR 范围 | 0145–0185 |

## 2. 本轮（R101–R126）完成

| 轮 | 内容 | 证据 |
|---|---|---|
| R101–R104 | 完成事件核查、多组预算停止、只读任务证据、停滞暂停 | 真实 mission |
| R105–R107 | GOAL-02 卡收口、违规归档、只读查看 | 卡 + ADR |
| R108–R111 | 强杀恢复闭环（组/任务对账、续接图修复、测试） | 真实闭环 + 单测 |
| R112–R114 | 归档轮转、指令门面、rework 组真实演练 | 单测 + trace |
| R115–R117 | 完成事件有界重试、真实 12+ 组停滞、GOAL-02 交付报告 | 真实 |
| R118–R119 | 轮转归档可读、台账更正 | 单测 + 真实 CLI |
| R120–R122 | 写回引擎、写回 CLI、整 mission 对齐 | 真实数据写回 |
| R123–R124 | 持久任务映射、发布端自动登记（`*` 哨兵） | 双节点端到端 |
| R125 | 扫描记录持久化 + `scan-records` 只读查看 | 真实 mission 落盘 |
| R126 | 按 taskId 优先派发（有界） | 调度器/门面单测 |

## 3. PLAN_STATUS §B 现状

| 项 | 状态 |
|---|---|
| B1 按 taskId 派发 | ✅ 有界（优先启动；乱序/抢占/跨进程不支持） |
| B2 写回执行端 | ✅ 引擎 + CLI + 真实数据 |
| B3 `investigation` 组信号 | ❌ 无本地客观信号（设计如此） |
| B4 归档历史保留 | ✅ R118（读取轮转文件） |
| B5 组标识唯一 | ✅ R64 已缓解（8 位随机令牌） |
| B6 扫描记录持久化/UI | ✅ 持久化 + 只读查看（UI 未做） |

## 4. 剩余主要缺口

1. **乱序派发 / 运行中改图**（ADR-0052）——需单独立项；
2. **B3 调查组信号**——需产品先定义判定源；
3. 写回：批准无身份校验、批量非原子、`needs-human-review` 仍人工；
4. 映射：仅首次发布自动登记、过期不清理、无反向查询；
5. 扫描记录：fire-and-forget 可能丢尾、无轮转/过滤/UI、接收器全局单例；
6. 测试：负载下偶发瞬时失败（单跑/重跑通过），未归因。

## 5. 工作区未提交文件（**用户所有，未被我暂存**）

```
 M docs/tasks/B6R-11-COVERAGE-SPRINT.md
 M docs/tasks/GOAL02_BOUNDED_GOAL_STABILITY.md
 M docs/tasks/NEXT60_PLAN_2026-10-29.md
 M docs/tasks/RESUME02_EXPERIMENTAL_SMART_CONTINUATION.md
?? docs/tasks/ARCHIVE_REVIEW_2026-10-30.md
?? docs/tasks/ARCHIVE_REVIEW_2026-11-01.md
?? docs/tasks/ARCHIVE_REVIEW_2026-11-01_INCREMENTAL.md
?? docs/tasks/archive/completed-checkpoints/B6R-11-COVERAGE-SPRINT.md
?? docs/tasks/archive/completed-checkpoints/GOAL02_R117_COMPLETED.md
?? docs/tasks/archive/completed-checkpoints/NEXT60_PLAN_2026-10-29.md
```

这些是用户在并行整理的归档/评审文件；本次总览**未修改、未提交**。

## 6. 建议下一步

1. 决定 §5 文件的归属（提交/丢弃/移动）；
2. 若要继续能力线：**B3 调查组信号**（需先定义产品判定源）或 **乱序派发立项**（结构性）；
3. 或做一次外部复核（按 ADR/报告逐条走查真实证据）。
