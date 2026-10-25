# UX-01 实施映射（UX-01-01）

状态：进行中（静态盘点完成，按任务卡固定信息架构实施；本轮不运行测试/构建/人工验收）。
日期：2026-10-26。

## 1. 能力矩阵

状态含义：
- `wired`：现有公共 API/UI 已有真实链路；
- `limited`：已有后端但入口分散/仅部分界面；
- `unimplemented`：本轮保留入口并显示“尚不可用”，不新增业务协议；
- `future`：明确不在本轮范围。

| 用户能力 | TUI 入口 | GUI 入口 | 公共 API / 源文件 | 权限/边界 | 状态 |
|---|---|---|---|---|---|
| 发送指令/会话 | 输入区、`/compose`、`/clear` | 项目工作区会话 | `PublicApplicationService.submitTask`、`/commands/submit`、`/commands/send-project-message` | 现有会话/项目归属 | wired |
| 查看执行/任务 | `/tasks`、任务面板 | 任务中心 | `/projects`、`/projects/chat` | 只读 | wired |
| 依赖图 | `/dag` | 任务详情可选标签 | 现有 DAG 视图 | 只读 | limited |
| Agent 列表/状态 | `/agents`、AgentsPanel | 项目设置/头像菜单 | `/projects/agents`、`/projects/agent-messages` | 只读 + 项目设置 | wired |
| 投递 Agent | 输入策略/拓扑选择 | 输入框「投递给」 | `targetAgentInstanceIdentifier` | 项目归属复核 | wired |
| 待授权 | 权限决策面板 | 待处理中心 | `/permissions/pending` 类路由 | 仅用户裁决 | wired |
| 安装确认 | 安装询问面板 | 待处理中心 | 安装询问 API | 单次批准 | limited |
| 澄清 | ClarificationPanel | 待处理中心 | clarification API | 用户回答 | wired |
| 恢复裁决 | 恢复入口 | 待处理/恢复 | 恢复路由 | 只读/裁决 | limited |
| 成果/文件 | 文件夹授权面板、工具结果 | 文件与产物 | 工作区路由、工具结果 | 项目边界 | limited |
| 历史 | `/status`、会话 | 历史 | `/projects/chat`、运行历史 | 只读 | wired |
| 模型账户 | `/model` 提示 + CLI | 设置→模型与账户 | `/settings/model-accounts` | 凭据只写 | wired |
| 权限模式/细分 | `/permissions` | 设置→权限模式 | permission profile API | 公共控制面 | limited |
| 上下文预算 | `/status` 间接 | 设置→上下文与历史 | 现有预算 API | 高级设置 | limited |
| 工作时段 | 无 | 设置→任务与工作时段 | work-window API | 高级设置 | limited |
| 备份/恢复 | 无 | 设置→数据与备份 | `/settings/storage`、export/restore | 安全备份 | wired |
| 工具/工作流 | ToolPackagePanel | 工作流与工具 | tool package API | 授权变更 | limited |
| 用量 | `/usage`（本轮接线/不可用如实显示） | 用量与运行帮助 | 用量账目读取 | 只读，未知不报零 | limited |
| 诊断/支持包 | 开发入口 | 支持包 | 脱敏导出 | 用户确认 | future |
| 开始页/最近项目 | 无（TUI 会话入口） | 开始页 | `/projects/managed` | 只读 | unimplemented→本轮实现 |

## 2. 现有源文件位置

- TUI 根组件：`packages/tui/src/ui/app.tsx`
- TUI 焦点：`packages/tui/src/ui/panel-navigation.ts`
- TUI 命令：`packages/tui/src/ui/slash-commands.ts`
- TUI 面板：`packages/tui/src/ui/components/panels.tsx`
- GUI 页面/路由：`packages/gui/src/server/gui-server.ts`、`project-chat-routes.ts`
- GUI 读取模型：`packages/gui/src/application/project-chat-view.ts` 等
- Electron 壳：`desktop/electron/main.mjs`

## 3. 从普通界面移出（发布包）

| 内容 | 去向 |
|---|---|
| mock/seed/fixture、测试事件注入、制造失败 | 仅显式开发启动配置；生产路由不注册 |
| raw JSON / schema / revision / IPC / 内部“已装配” | 普通页面移除；脱敏技术详情进支持包 |
| “按 Agent 隔离”“未注入端口”“DTO”等实现说明 | 改为用户动作/影响说明；原因留在按需技术详情 |
| 开发诊断入口 | 保留在开发启动路径，不新增普通 UI 开关 |

## 4. 缺失后端能力（本轮显示不可用，不新增协议）

- TUI `/usage`：若公共 SDK 无现成用量读取，显示“尚不可用：缺少用量查询接口”，不报 0。
- TUI `/compose`：多行编辑为 UI 行为，需根组件状态；若未完成则保留入口说明，不伪造发送。
- GUI 开始页/最近项目：基于现有 `/projects/managed` 只读列表，不新增存储。

## 5. 验证状态

本轮按任务卡**不运行测试、不构建、不人工验收**；本文件只记录静态映射，不代表运行验证。
