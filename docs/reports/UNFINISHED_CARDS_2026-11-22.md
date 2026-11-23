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
## 卡片数量总览（2026-11-22 第 38 轮；57 个任务卡文件）

| 头行状态 | 数量 | 说明 |
|---|---|---|
| done / 已交付 | 5 | 以卡面与证据为准 |
| implemented-unverified | 16 | 有实现与反例，缺人工/平台验收 |
| in_progress / 部分交付 | 13 | 见各卡"剩余" |
| pending | 5 | E2E-01、RESUME-02、OCT28 索引等（含设计/排期性） |
| blocked | 1 | REMOTE-01（平台阻塞） |
| superseded | 2 | BATCH6、WB00 |
| 无状态行 | 15 | 索引/矩阵/交接/基线/计划类文件，非单卡验收对象（个别卡以"对账"代替"状态"字样，归类可能偏移） |

**用途**：给出"还剩多少、属于哪类"的数量级；**不替代**上面 A/B/D 分组与逐卡剩余说明。
本窗口（第 21–38 轮）已对 COORD-05、AUDIT-REPAIR-01、WIRING-04、SEC-02、SMART-01、PROJECT-01、
OBS-01、HISTORY-01、AR07、COMM-01、RELOCATE-01、TOOLKIT-01、CLIENT-01、EXP-01、SMART-01、
BATCH6/WB00 等卡完成头行/状态对账。
## 验证证据复核（2026-11-23，第 55 轮）

| 项 | 命令 | 结果 |
|---|---|---|
| 变异验证 | `verify:mutation-kills`（隔离副本：独立 node_modules + 复制 dist） | ✅ **313/313 被拦下**，exit 0；此前"312/313 且 5–10 分钟"因缺 dist 整组跳过，已作废 |
| 两进程陈旧写入 | `verify:two-process-stale-write` | ✅ 10 个存储全部拒绝旧写入 |
| 跨进程文件锁 | `verify:cross-process-lock` | ✅ 并发后 revision=41，无丢更新 |
| E2E-01 fixture | `verify:e2e01` | ✅ fingerprint 一致、基线失败、参考实现通过 |
| 覆盖率 / 包级 | `verify:security-coverage`、`verify:entry-runtime-selection`、`verify:tarball-install` | ⛔ 被 prepack 前置（3 环境失败 + 1 抖动）阻断，未记通过 |
| 全量门禁 | `npm test` | 895 files / 5722 tests；4 失败 = 3 环境 + 1 已验证抖动 |

**对账结论补充**：
- **AUDIT-04**：`LocalCompletionVerifier` 与权威门禁**不等价**（尝试 ID 重放、未决工作项、证据门禁、活锁/预算/Provider 干净结束未覆盖）⇒ 保留历史、写明后继，不宣称已替代。
- **WIRING-04-01**：信封字段与比较逻辑已有，但**无生产者盖章**、消费端恒 null ⇒ 需产品定义"执行尝试"权威来源。
- **EXEC-01-04**：SDK/CLI 事件面**已接**（脱敏事件 + CLI JSONL 订阅），卡面"未接"已更正；**03 输出扫描闸未接线**，是否阻断属安全策略决策。
- **COORD-05**：用户路径端到端已证；秘书通道已端口化（激活/投递由宿主注入），真实宿主实现与 agent 路径仍缺。
## 最终验证状态（2026-11-23，第 59 轮）

- **常规全量门禁：全绿**（893 files / 5715 tests / 7 skipped，exit 0；`typecheck` / `lint` 0）。
  此前 3 条"环境失败"中：`exec01-02` 为**真缺陷**（已修），两条 symlink 用例为**测试清理缺陷**（已修），
  `graph-change-deterministic-drill` 为**时序断言缺陷**（已改轮询/超时预算）。
- **覆盖率**：5715 tests 全绿并生成 summary；**全局分支 80.78% < 85%**（真实缺口）。
- **安全模块覆盖**：18/22 达标 95%；未达标 4 个见 SEC-02 卡（最低 `sensitive-content-access-policy` 74.11%）。
- **包级脚本**：`verify:security-coverage` 已可运行并给出上述结果；`verify:entry-runtime-selection` /
  `verify:tarball-install` 依赖 `npm pack`+prepack，门禁全绿后应可运行，留待下一轮确认。

**仍未闭合（性质）**：① 四模块覆盖率与全局分支阈值（需补测试）；② 包级三脚本结果确认；
③ 人工体验/跨平台证据；④ 产品决策（秘书激活、Agent 工具入口、EXEC B1–B4、外发通道）。
## 决策落地与验证更新（2026-11-23，第 61–73 轮）

用户补充了 D1–D8 决策（`PRODUCT_DECISIONS_2026-11-23.md`），本窗口据此实施：

| 决策 | 落地 | 证据 |
|---|---|---|
| D1 秘书通道 | 单通道锁定（`selectedChannel`），重试沿用同通道；激活状态读取失败保持待呈交 | `coord05-channel-lock.test.ts` 4 条 + 门禁 |
| D2 取消语义 | 派发过滤 + 真实派发入口反例（启动数/提案文件为 0，保留对照） | `d2-cancelled-node-dispatch-loop.test.ts` 4 条 |
| D3 缓存 | 保留候选、不接线（照裁决） | 文档 |
| D4 执行尝试 | `executionAttempt` 单调落盘、worker 盖章、消费端取任务链节点 | `execution-attempt.test.ts` 4 条 |
| D5 输出 block | `outputScanPolicy=block` 默认；**完整流扫描**（8 MiB 预算）非 clean 不释放 | `exec01-03-output-scan-block`、`exec01-03-whole-stream-scan` 共 8 条 |
| D6 外发 | 出口清单 7 项；MCP stdio 接内容扫描（默认 block） | `OUTBOUND_EXITS_INVENTORY_2026-11-23.md`、`mcp-outbound-content-scan.test.ts` |
| D7 模型工具入口 | 协作请求为宿主专用（非模型工具），3 条反例 | `d7-no-model-collaboration-tool.test.ts` |
| D8 覆盖率 | 安全模块 **21/22**（仅 `entrypoint` 90.9%，剩余 7 行不可达/需注入） | `SEC02_LOCAL_SCAN_COVERAGE.md` |

### 更新后的验证状态

- **全量门禁**：907–908 files / 5788–5793 tests；偶发 1 条并发抖动（`cross-project-ledger-concurrency`、
  `journal-append-concurrency` 等，隔离复跑通过），其余全绿；`typecheck`/`lint` 0。
- **覆盖率**：全局分支 **80.92%**（<85%）；安全模块 21/22。
- **包级脚本**：`verify:security-coverage` 可运行；`verify:entry-runtime-selection` 曾因 graph-drill 抖动失败，
  修复后**未重跑确认**；`verify:tarball-install` 仍未运行。

### 仍未闭合（按性质）

1. **产品口径**：D6-E2 的"目的端/资源范围/授权 revision"模型；Provider 通道默认 record/block；
2. **平台/人工证据**：EXEC-01-02 沙箱后端、REMOTE-01 平台投递、E2E-01 人工体验、GUI/TUI 未建视图；
3. **覆盖率**：全局分支达 85%、`entrypoint` 剩余不可达行；
4. **包级脚本**：`entry-runtime-selection`、`tarball-install` 结果确认；
5. **实现后继**：`taskRevision` 独立盖章、逻辑派发重投复用 attempt、ALIGN-02 规划路径的端到端演练。
## 包级脚本最终状态（2026-11-23，第 75–76 轮）

| 脚本 | 结果 |
|---|---|
| `verify:security-coverage` | ✅ 可运行；关键安全模块 **21/22**（`entrypoint` 90.9%，剩余 7 行不可达/需注入） |
| `verify:entry-runtime-selection` | ✅ **18/18 通过**（3 项不适用：公开构建无 Web GUI）；tarball sha256 `719fc4c0…f3704bb` |
| `verify:tarball-install` | ✅ exit 0："tarball-isolation-install-ok: 安装后 CLI 版本 0.1.0" |

此前归为"被 prepack 阻断"的三条脚本均**已执行并给出真实结论**；其中 entry-runtime 脚本的
JSON 解析、状态目录隔离与 CLI-only 构建判定三处缺陷已修复。