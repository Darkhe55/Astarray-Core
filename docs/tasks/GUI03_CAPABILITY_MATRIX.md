# GUI-03 能力接线矩阵

日期：2026-10-26。状态：初版（静态审计 + 本轮接线进度），不是完成率。

| 编号 | 能力 | UI 控件 | HTTP 路由 | 公共服务 | 权威存储 | 运行时消费者 | 当前状态 |
|---|---|---|---|---|---|---|
| F01 | 通知偏好 | 设置→通知 | localStorage | 无 | 本地偏好 | 应用内/系统通知 | 已编码（完成/失败/待处理/系统通知；系统通知需许可） |
| F02 | 实验功能 | 设置→实验功能 | 无 | 无 | 无 | 无 | 占位不可用 |
| F03 | 工具包写操作 | 设置→工作流与工具 | lifecycle + preview/install zip | LifecycleService + ZipInstaller | lifecycle JSON + packages | 工具注册 | 已接：安装/启用/停用/升级/回退；逐项授权确认未细分 |
| F04 | 项目权限覆盖 | 设置→项目权限 | `/settings/scoped`、`/commands/scoped-permission` | ScopedSettingsStore | 项目覆盖 JSON | 任务工具 PolicyWrapper | 已接（按项目在任务端口创建时选择覆盖 profile） |
| F05 | 项目工作时段 | 设置→工作时段 | 无 | WorkWindow 组件 | 无 | 分派/恢复 | 占位不可用 |
| F06 | 项目上下文覆盖 | 设置→项目上下文 | `/settings/scoped`、`/commands/scoped-context-budget` | ScopedSettingsStore | 项目覆盖 JSON | 提示词装配 | 已接装配（按 mission 摘要解析项目） |
| F07 | 指令队列 | 设置→指令队列 | `/state`、`/commands/instruction-window-capacity`、`/commands/prioritize-instruction` | InstructionWindowStore | instruction-window JSON | 指令排队 | 已接：FIFO、容量、手动置顶；无 mode |
| F08 | 会话模型切换 | 设置→当前模型 | `/settings/model-bindings`、`/settings/model-candidates`、`/commands/model-binding` | ModelRuntimePool + binding + mission preparer + 多账户配置 | 模型绑定 JSON | 下一次任务 runtime | 已接：多账户、候选下拉、会话/应用绑定、任务边界切换、applied/failed 状态；fake-runtime 端到端通过 |
| F09 | 会话临时权限 | 设置→临时权限 | `/settings/session-elevations`、`/commands/create-session-elevation`、`/commands/revoke-session-elevation` | SessionPermissionElevationController | elevation JSON | 权限解析 | 已接：列表/创建/撤销；profile/revision 由服务端派生 |
| F10 | 会话上下文覆盖 | 设置→当前上下文 | `/settings/scoped`、`/commands/scoped-context-budget` | ScopedSettingsStore | 会话覆盖 JSON | 提示词装配 | 已接装配（missionId 作为会话） |
| F11 | 任务成果记录 | 成果页任务成果 | `/settings/artifacts`、`/settings/mission-artifacts` | ArtifactRecordStore + 工具 producedArtifacts + mission 登记 | 成果 JSON | 无重跑 | 已接（create/replace 工具级登记 + mission 回退；端到端未做） |
| F12 | 参数级工具授权 | 设置→默认权限模式 | `/settings/parameter-authorization/details`、`/commands/parameter-authorization-rules` | 规则明细 + CAS 写入 | 参数规则存储 | 工具门禁 | 已接（读取/编辑/CAS/放宽确认；确认靠认证 CSRF 请求头） |

## 四项漏项

| 编号 | 状态 | 证据 |
|---|---|---|
| R01 模块拆分 | 已编码 | `ui/navigation.ts`、`ui/theme.ts`、`ui/settings.ts`、`ui/conversation-scroll.ts`、`ui/detail-panel.ts` 均已真实使用 |
| R02 保存并离开 | 已编码 | 模型账户/预算写入等待真实 Promise `saved`；显示开关为纯视图状态、不写服务；数据页按钮各自有独立结果 |
| R03 稳定消息 ID 计数 | 已编码 | `chatBubbleStableKey` + `renderedBubbleIds`；未做真实流式验收 |
| R04 详情宽度同步 | 已编码 | `--chat-detail-width` + `ResizeObserver`；未做拖拽后视觉验收 |

## 说明

- 仅路由存在不等于接线；仅写配置无消费者不算接好。
- F01–F12 中大部分仍是设置占位，不能据本表宣称已实现。
- 本表随 GUI-03 各检查点推进更新。




































