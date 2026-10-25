# UX-01 实施交接（当前进度）

状态：in-progress（编码进行中；本轮未测试、未构建、未人工验收、未提交/推送 Git）。
日期：2026-10-26。

## 1. 修改文件

### 共享文档
- `docs/tasks/UX01_IMPLEMENTATION_MAP.md`（新建）
- `docs/tasks/UX01_TUI_GUI_PRODUCT_LAYOUT_TASK_CARD.md`（状态/进度）
- `docs/tasks/UX01_IMPLEMENTATION_HANDOFF.md`（本文件）

### TUI（`astarray-ui/packages/tui/src/ui/`）
- `app.tsx`：
  - 默认单主区；`/dag`、`/agents` 才切换；
  - ≥120 列显示 40 列详情侧栏，<120 全宽；
  - <80 列隐藏 Header 指标、PanelFocusHint、指令窗口、工具包、参数授权，显示尺寸提示；
  - 多行编辑：Enter 换行、Tab 发送、Esc 返回并保留草稿；
  - Ctrl+C 安全语义：草稿先清空保留、任务需二次确认、无任务提示 `/quit`。
- `state/app-state.ts`：`isComposeMode`、`pendingStopMissionId`、`recoverableDraft` 与相关方法。
- `slash-commands.ts`：新增 `/usage`、`/compose`、`/quit`、`/tasks`、`/files`、`/history`、`/workflows`、`/settings`；`/tasks` 输出状态/子任务数摘要。

### GUI（`astarray-ui/packages/gui/src/server/`）
- `gui-server.ts`：
  - 开始页（新建项目/最近项目）；
  - 项目标签：会话/任务/成果/历史；
  - 任务中心：全部/进行中/待处理/已完成筛选；
  - 历史中心：按时间倒序，只读；
  - 成果页：项目文件夹、打开工作区、复制路径；
  - 待处理中心：授权/追认/安装/澄清数量，跳转现有裁决区块；
  - 360px 详情抽屉（任务/历史先看详情再打开）；
  - 256/56px 导航；1100/900 断点；900px 以下项目导航抽屉；
  - 设置新增用量/帮助分类；隐藏历史「原始」入口；移除内部标题；
  - 桌面访问票据（HttpOnly cookie）。
- `project-chat-routes.ts`：
  - Electron 下 `/commands/pick-folder` 返回 501（native-only）。
- `desktop/electron/main.mjs`、`preload.cjs`：
  - 原生文件夹选择器 `dialog.showOpenDialog` + IPC；
  - IPC 发送者校验；
  - splash、120 秒上限、2 次重试（1s/3s）、失败页（重试/打开日志/退出）；
  - 主窗口禁止导航离开本地源。

### 构建/安装
- `scripts/build-electron.mjs`：Electron 包、复制 preload、安装到 `%LOCALAPPDATA%\Programs\Astarray`、数据迁移。
- `scripts/install-desktop.mjs`、`start-desktop.mjs`。
- `package.json`：`build:desktop` / `install:desktop` / `start:desktop`。

## 2. 能力入口

已接线（静态）：
- 会话发送、任务列表、历史、成果文件夹、待处理计数、模型账户、设置分类；
- 原生文件夹选择；
- 桌面启动可见性/失败页。

明确不可用（不伪造）：
- GUI 用量账目：设置页已接 `/observability/usage`，输入 token 未知显示“不可判定”，金额未估算；
- 支持包导出：未实现；
- 成果文件预览/差异：只提供工作区入口；
- 待处理独立裁决详情：复用现有区块；
- TUI `/workflows`、`/settings`：仅说明入口，未做完整管理页。

## 3. 未完成 / 阻塞

- UX-01-03：`/tasks` 已支持列表与 `/tasks <序号>` 子任务详情；命令面板三级直达/搜索结果定位仍缺。
- UX-01-04：已新增间距/圆角/主色/危险色 token，并用于任务卡与详情抽屉；其余旧样式尚未全部替换；抽屉已补遮罩、Esc 关闭和焦点归还。
- UX-01-05：成果页已列工作区文件并复用现有预览/编辑；待处理分类点击先显示 360px 详情抽屉（类型/数量/影响说明），「去处理」进入现有裁决区；差异视图与内嵌裁决仍未完成。
- UX-01-06：用量设置页已接 `/observability/usage`；帮助页支持包已实现“预览范围 → 勾选确认 → 本地 zip 导出”，只含脱敏日志/README，不含凭据/会话/源码，不自动上传。Agent/工具完整分组仍缺。
- UX-01-07：本文件与矩阵复核仍需随剩余检查点更新；未到 implemented-unverified 条件。
- 原生 Electron 启动崩溃（本机 `0xC0000005`）仍为独立未解决/未验证项；安装到 LocalAppData 后可启动，但不声称根因已修复。

## 4. 未验证声明

本轮（含最终复核轮）未运行 `npm test`、Vitest、构建、启动、浏览器走查或人工验收；以上只代表代码与文档改动，不代表运行通过或可发布。整体状态保持 in-progress：UX-01-03/04/05/06 仍有明确未完成项，未达到 implemented-unverified 条件。









