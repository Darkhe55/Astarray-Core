# UX-01 实施交接（当前进度）

状态：implemented-unverified（编码完成；已运行测试/构建并提交推送；未人工验收）。
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

## 3. 明确不可用能力（不是未编码）

- **工具包安装/升级/权限变更**：GUI 只提供只读版本/差异；写操作缺少后端协议，按钮/文案明确未接线，不伪造成功。
- **待处理独立裁决**：待处理中心把现有授权/追认/安装区块移入本页并刷新，直接复用既有裁决 API；没有第二套权限逻辑。
- **原生 Electron 启动崩溃**：安装版正常、兼容模式可用；根因未完全关闭，列为独立未解决问题。
- **人工验收**：本轮只完成自动测试/构建/桌面启动，未做逐页人工体验验收。

## 4. 未验证声明

本轮已运行 typecheck、全量测试、Electron 构建/安装与窗口冒烟；未做逐页人工验收。整体标记 implemented-unverified（编码完成、自动验证通过、未人工验收）。



















