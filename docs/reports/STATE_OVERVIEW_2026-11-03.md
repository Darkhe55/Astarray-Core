# 仓库状态总览（2026-11-03，R140 更新）

> 只读盘点。工作区里**用户/他人的未提交文件原样保留**（见 §6），本文件不处理它们。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `022dd73a`（`test(core): guard the drill against a missing mission id`） |
| 与远端 | `ahead=0` |
| 全量测试 | **3653 tests 全通过**（`--maxWorkers=2`，无 Errors） |
| 其它门禁 | `typecheck` / `lint` / `build` 全绿 |
| ADR 范围 | 0145–0197 |
| PLAN_STATUS | 到 **212** |

## 2. 本阶段（R101–R139）新增能力

| 轮 | 内容 |
|---|---|
| R101–R104 | 完成事件核查、多组预算停止、只读任务证据、停滞暂停 |
| R105–R107 | GOAL-02 收口、违规归档、只读查看 |
| R108–R111 | 强杀恢复闭环（组/任务对账、续接图修复 + 测试） |
| R112–R114 | 归档轮转、调度器指令门面、rework 组真实演练 |
| R115–R117 | 完成事件有界重试、真实 12+ 组停滞、GOAL-02 交付报告 |
| R118–R119 | 轮转归档可读、台账 §B 更正 |
| R120–R122 | 写回引擎、写回 CLI、整 mission 对齐（真实数据写回） |
| R123–R124 | 持久任务映射、发布端自动登记（`*` 哨兵） |
| R125 | 扫描记录持久化 + `scan-records` 只读查看 |
| R126 | 按 taskId 优先派发（有界） |
| R127–R128 | 状态总览、显式乱序派发 |
| R129–R131 | 修订 pending 任务、安全点注入/删叶子、重连依赖 |
| R132–R133 | 图变更审计、图变更 ⇒ 目标联动（暂停） |
| R134–R137 | 图变更后自动重算 V、接线修复、确定性与 V 上升演练 |
| R138–R139 | 暂停后恢复（replan）、删除任务时清理映射 |

## 3. 运行中改图 + 目标联动闭环

| 能力 | 状态 | 证据 |
|---|---|---|
| 安全点注入 / 删 pending 叶子 / 修订内容 / 重连依赖 | ✅ | 单测 13 条 |
| 图变更审计（before/after，含 mission 过滤） | ✅ | 真实 store 测试 |
| 图变更 ⇒ V 重算 ⇒ 不暂停 / 暂停（V 上升） | ✅ | 确定性夹具 2 用例 |
| 暂停后恢复（`goal-mode replan`） | ✅ | CLI 夹具 + 单测 |
| 映射自动登记 / 删除清理 | ✅ | 单测 |
| 接线透传（journal/onGraphChanged） | ✅ | R135 修复 + 测试 |

## 4. 写回 / 记账闭环

| 能力 | 状态 |
|---|---|
| 提案生成（只读） | ✅ |
| 应用引擎（人工批准 + revision 双校验） | ✅ 单测 |
| CLI `task-ledger apply-writeback` | ✅ 真实数据（`mission-90bc56fb`） |
| 整 mission / 显式映射对齐 | ✅ 单测 + 真实数据 |
| 冲突/陈旧拒绝 | ✅ |

## 5. 仍未闭合（按性质）

| 项 | 性质 |
|---|---|
| B3 `investigation` 组信号 | **产品语义未定**（无本地客观信号） |
| 真实业务路径的 V 上升 | 产品语义（需"已完成映射任务失证"） |
| 运行中重连（有在途任务） | 一致性设计 |
| 批量换图 / 图回滚 | 需立项 |
| 恢复后自动继续派发 | 设计选择（当前不自动） |
| 归档/扫描记录轮转与过滤、UI | 运维增强 |
| 真实 mission 图变更演练 | 已用确定性夹具替代（模型波动） |

## 6. 工作区未提交文件（**用户所有，未被我暂存**）

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

## 7. 建议下一步

1. 决定 §6 文件的归属（提交/丢弃/移动）；
2. 产品定义 **B3 investigation 信号** 后再实现；
3. 或对 R101–R139 做一次外部复核（按 ADR 逐条走查真实证据）。
