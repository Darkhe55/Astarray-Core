# 仓库状态总览（2026-11-03，R142 更新）

> 只读盘点。工作区里**用户/他人的未提交文件原样保留**（见 §6），本文件不处理它们。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `b5a68958`（`feat(core): infer investigation groups from read-only tool declarations`） |
| 与远端 | `ahead=0` |
| 全量测试 | **3657 tests 全通过**（`--maxWorkers=2`；负载下偶发超时，单跑/重跑均绿） |
| 其它门禁 | `typecheck` / `lint` / `build` 全绿 |
| ADR 范围 | 0145–0198 |
| PLAN_STATUS | 到 **214** |

## 2. PLAN_STATUS §B 清单：全部有实现或明确结论

| 项 | 状态 | 证据 |
|---|---|---|
| B1 按 taskId 派发 | ✅ 有界（优先/乱序；不抢运行中） | R126/R128 + 单测 |
| B2 写回执行端 | ✅ 引擎 + CLI + 真实数据 | ADR-0179/0180/0182 |
| B3 investigation 信号 | ✅ **已确认**（全只读组，返工优先） | ADR-0198 + 单测 10/10 |
| B4 归档历史保留 | ✅ 读取轮转文件 | ADR-0178 |
| B5 组标识唯一 | ✅ 缓解（8 位随机令牌） | ADR-0127 |
| B6 扫描记录持久化/UI | ✅ 持久化 + 只读 CLI（UI 未做） | ADR-0184 |

## 3. 本阶段（R101–R141）新增能力

| 主题 | 内容 |
|---|---|
| GOAL-02 | 完成事件核查/重试、真实 12+ 组停滞、多组预算停止、rework 组真实演练、最终交付报告 |
| 恢复 | 强杀恢复闭环（组/任务对账、续接图修复）、暂停后恢复（replan） |
| 运行中改图 | 注入 / 删 pending 叶子 / 修订内容 / 重连依赖 + 审计 + 目标联动（V 重算决定暂停） |
| 写回/记账 | 提案引擎、CLI、整 mission 对齐、持久映射与发布端自动登记、删除清理 |
| 可观察 | 违规归档（轮转/读取）、扫描记录持久化、图变更审计 |
| 组性质 | investigation 本地信号（全只读组） |

## 4. 关键验证方式

- **确定性夹具**替代真实模型：权限询问制造安全点，验证图变更 → V 重算 → 暂停/不暂停；
- **真实数据写回**：`mission-90bc56fb`（整 mission 对齐）；
- **真实 CLI 夹具**：违规查看、replan、graph-changes、writeback；
- **单测**：调度器/组性质/映射/审计/重算判定。

## 5. 仍未闭合（按性质）

| 项 | 性质 |
|---|---|
| investigation 定义 | ✅ 2026-11-03 产品确认（全只读；返工优先） |
| 只读组不计停滞的代价 | ✅ 已确认接受（3A：沿用卡内检查点 02） |
| 运行中重连（有在途任务） | 一致性设计 |
| 批量换图 / 图回滚 | 需立项 |
| 真实业务路径 V 上升 | 产品语义 |
| 恢复后自动继续 | 设计选择（当前不自动） |
| 归档/扫描记录过滤与 UI | 运维增强 |
| 测试稳定性 | 负载下偶发超时（非失败断言） |

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

1. 处理 §6 的 10 个文件（提交/丢弃/移动）；
2. ~~产品确认 investigation 定义~~（2026-11-03 已确认：全只读 + 返工优先）；
3. 或做一次 R101–R141 的外部复核（按 ADR 逐条核对真实证据）。
