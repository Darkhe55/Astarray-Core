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

## 本窗口（2026-11-22）新增证据

- **COORD-05**：05-01/02/03/04/05/06 核心全部落地，另有公开门面（open/handle/query）与调度闸门；
  反例累计 40+ 条；状态 `implemented-unverified`，剩余为整卡装配（见该卡验收小结）。
- **AUDIT-REPAIR-01**：01 补 handler 级 7 条 + wrapper 级未分配/deny 2 条；卡状态由过期 `pending`
  校正为 `implemented-unverified`；剩余为 01 应用矩阵（缺 worker 工具可观测端口）、03 生产接线、04 等价核查。
- **WIRING-04-04**：任务包映射分类/自愈边界/解析结果补 9 条反例；04-02/03/05 仍未开始。
- **状态校正**：BATCH6（已被 T06E/F/G/T08A 的 B6R 返修取代）、WB00（由 GUI-01-R 接管）。

## 窗口结论

本窗口**未完成全部任务卡**，也不宣称完成。未闭合项以本文件 A/B/D 三组为准；
其中 B 组（人工体验/平台证据）与 D 组（产品决策）**不是本仓单方面可闭合**的。
下一窗口建议顺序：COORD-05 装配 → AUDIT-01 应用矩阵（先建 worker 工具可观测端口）→ WIRING-04-02/03。
## 对账更新（2026-11-22，第 33 轮；**本表覆盖上方过期行**）

| 卡 | 现状 | 真正剩余 |
|---|---|---|
| WIRING-04 | implemented-unverified | 01 revision/执行尝试核验（消息无字段，阻塞）；真实任务序列映射端到端 |
| SEC-02 | in_progress | 通道 15 外发门禁无调用方；通道 9 OCR；MCP 四态扫描默认 record |
| SMART-01 | in_progress | TUI/GUI 两入口；包级验收与真实运行证据（SDK+CLI 已接） |
| PROJECT-01 | implemented-unverified | CLI 其余文件操作统一收口；跨平台证据 |
| ALIGN-01/02/03/04 | implemented-unverified | 01-03/01-04/01-06 已收口（11-05/08）；02/03 已有 11-05/09 追加；仍缺自动触发点与人工验收 |
| OBS-01 | implemented-unverified | 开关默认决策；Provider/Git/恢复外错误路径；跨平台测量 |
| HISTORY-01 | implemented-unverified | TUI 视图/虚拟列表/搜索/锚点；人工体验；分段存储（设计决定） |
| AR07 | in_progress | Linux 证据已取得（WSL2 11-08）；macOS 证据缺 ⇒ 不判通过 |
| COMM-01 | 03 本地可证 done | GUI 入口；跨平台证据 |
| STARTUP_RECOVERY | 已交付（11-06） | 后续以 11-10 归档记录为准 |
| MERGE-01 | 01/02/03 done（本地口径） | 人工体验；Linux/macOS 证据 |
| COORD-05 | implemented-unverified | 秘书通道（无权威激活状态，产品阻塞）；三路径端到端 |
| AUDIT-REPAIR-01 | implemented-unverified | 03 生产接线；04「被替代」等价核查；01 取消语义（产品定义） |
| E2E-01 | pending | 人工体验结论；Linux/macOS 证据 |

**共同结论**：剩余缺口集中在三类——①人工体验/跨平台证据（本仓无法闭合）；②产品决策（秘书激活、外发通道、
Agent 工具入口、缓存接线）；③TUI/GUI 尚未建立的视图。**不把对账更新当作完成声明。**