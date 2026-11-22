# 未完成任务卡清单（2026-11-22 审计）

> 本文件是**只读对账**，不做完成声明；状态以卡面与 `PLAN_STATUS.md` 为准。
> 目标：让"还剩什么、卡在哪、下一步是什么"可一眼查清，避免用单轮进度掩盖未闭合项。

## A. 可在本仓继续推进（无产品/平台前置）

| 卡 | 状态 | 已落地 | 剩余 / 下一步 |
|---|---|---|---|
| COORD-05 逐级请示 | implemented-unverified | 六个子卡核心 + 门面 + 调度闸门（见卡内验收小结） | 编排器自动 `markDecisionApplied` 接线；真实任务链调度装配；三路径端到端 |
| AUDIT-REPAIR-01 | implemented-unverified | 01–04 代码与反例、05 隔离包 | 01 应用装配矩阵（需 worker 工具可观测端口）；03 生产接线；04「被替代」等价核查 |
| WIRING-04 可靠消费 | pending（01 in_progress） | 01 部分：消费意图先持久化 | 02 请求投递生命周期事实；03 完成门禁生产入口；04 上下文包映射；05 回访与整链 |
| SEC-02 通道/凭据/本地扫描 | in_progress | 01–07 部分交付 | 逐项补证据；整卡未闭合 |
| SMART-01 指令窗口 | in_progress | 02/03 组件、04 SDK 入口 | CLI/TUI/GUI 三入口、包级与真实运行证据 |
| PROJECT-01 跨项目 | in_progress | 授权/回执/查询组件 | 实际资源读取/导入 I/O 接线 |
| EXEC-01 受控执行 | 主体交付 | 6 项；2 项 implemented-unverified | B1–B4 待产品决策 |
| CLUSTER-01 诊断相似度 | 01–03 交付 | 04 implemented-unverified | 待人测 |
| MERGE-01 | 见卡内状态 | 参数授权/指令合并已交付 | 以卡内未闭合项为准 |
| GOAL-02 | R105 收口 | 01–03 要求与 9 条验收 | 强度/边界类未演练项 |
| ALIGN 系列 | in_progress | 01/02/03/04 多数检查点 | 01-03 入口无自动调用方、01-04 直投消费、01-06 仅 assist 终态 |
| RELOCATE-01 / OBS-01 / LESSON-01 / EXP-01 / CLIENT-01 | in_progress / re-verifying | 部分纯判定层/组件 | 生产接线与人工验收 |
| OCT28_CORE_EXTENSION_INDEX | 任务设计完成 | —— | 编码全部 pending（需排期） |
| RESUME-02 | pending | 仅设计 | 首版未实施（按设计不应自动开启） |
| HISTORY-01 / STARTUP_RECOVERY / B6R-11 | 无状态行 | 见各自卡与报告 | 先对账再定 |

## B. 需人工体验或平台证据（本仓无法闭合）

| 卡 | 状态 | 缺口 |
|---|---|---|
| E2E-01 独立工作助手 | pending（本地可证项已通过） | 人工体验结论、Linux/macOS 证据 |
| GUI-01-R | in_progress | 04b 真实用户人工体验、跨平台证据 |
| B6R-04b TUI 权限组 | implemented-unverified | 真实 TTY 人工验收 |
| REMOTE-01 | blocked | 平台测试租户/签名/回执 |
| COORD-01/02/03/04 | implemented(-unverified) | 人工验收（不标 done） |

## C. 已由后续工作取代（保留历史原文）

| 卡 | 结论 |
|---|---|
| BATCH6_REPAIR | T06E/F/G/T08A 在阶段表为 done（单平台口径，B6R-01…09） |
| GUI-MVP | 由 GUI-01-R 接管 |
| WB00 微编辑工作台原型 | 由 GUI-01-R 接管 |

## D. 产品决策阻塞

- COORD-02：Agent 工具入口（角色/审批/频率策略未定）、跨项目真实网络通道；
- EXEC-01：B1–B4（受控执行的产品边界）；
- GOAL-02：强制模式入口/激活入口/重新开启（宿主接线与迁移规则）。

## 口径

- 本清单不改变任何卡的历史结论；与卡面冲突时，以**最新带证据的进展记录**为准。
- `implemented-unverified` ≠ done；未跑产品路径的，不因单测通过升级。
