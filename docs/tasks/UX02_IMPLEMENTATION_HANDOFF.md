# UX-02 实施交接：GUI 导航、设置可达性与产品体验返修

日期：2026-10-26。状态：implemented-unverified（已运行 typecheck、654 项测试、开发 GUI 与安装版桌面冒烟；未做逐页人工视觉验收）。

## 1. 修改文件

- `astarray-ui/packages/gui/src/server/gui-server.ts`
  - 共享工作区导航、统一切页；
  - 设置分类页、作用域、未保存三选一；
  - 模型高级配置折叠；
  - 成果/项目文件分离；
  - 新消息提示与滚动保持；
  - ≥1100px 非模态详情、<1100px 模态抽屉；
  - Agent 普通菜单按钮；
  - 旧「更多」关闭与区块归置。
- 备份：`astarray-ui/.tmp/ux02-backups/20261026-190257/packages/gui/src/server/gui-server.ts`

未新增依赖、未改构建工具、未改公共业务内核。

## 2. 旧入口去向

| 旧入口 | 新位置 |
|---|---|
| 「更多」按钮 | 普通界面隐藏；恢复记录 → 历史页 |
| 待授权 / 追认 / 安装询问 | 待处理中心，内嵌现有裁决 |
| 用量 / 诊断 | 应用设置 → 用量与运行帮助 |
| 文件夹授权 | 项目设置 → 文件夹授权 |
| Agent 管理 | 项目设置 → Agent |
| 历史 / 观测 | 历史页与对应设置页 |
| 设置长页滚动 | 左分类 + 单分类内容 |

## 3. 新入口与作用域

- 应用设置：常规与外观、模型账户、默认权限模式、上下文默认值、通知、用量与帮助、数据与备份、实验功能、帮助与关于。
- 项目设置：文件夹授权、Agent、工作流与工具、项目权限、工作时段、项目上下文。
- 会话设置：输入策略、当前模型、临时权限、当前上下文。
- 顶部显示作用范围、当前项目和继承说明。

## 4. 实际接线 API

- 项目/任务：`/projects`、`/projects/messages`、`/projects/chat`、`/projects/agents`、`/projects/agent-messages`。
- 设置：`/settings/*`、`/settings/vendor-presets`、`/observability/usage`、`/state.toolPackages`。
- 授权/追认/安装：沿用原有 `/commands/permission-ask-decision` 等现有控制面。
- 成果：`/workspace/tree`、`/workspace/file`、`/workspace/diff`。
- 待处理计数：`/projects/messages/pending-counts`。

## 5. 缺失后端能力（明确不可用）

- 通知偏好；
- 实验功能；
- 工作时段；
- 项目级/会话级权限与上下文覆盖；
- 会话级模型切换；
- 工具包安装/升级/权限变更；
- 任务成果记录接口（当前显示“暂无可展示的任务成果”，保留项目文件辅助入口）。

以上均显示不可用/继承，不伪造成功。

## 6. 并行与阻塞

- 无并行冲突。
- Electron 原生启动故障、UX-01 人工未验收项不在本卡解决范围。

## 7. 验证结果

- `npm run typecheck`：通过。
- Vitest：**654 passed (654)**。
  - 新增 `tests/gui/unit/ux02-gui-repair.test.ts`（8 项）；
  - 更新 dialog 计数测试为 11（新增设置离开确认）。
- 开发 GUI（Edge CDP）：
  - 共享导航、4 个标签、19 个设置分类；
  - 每次仅显示 1 个分类；
  - 任务/成果/历史/待处理切换正常；
  - 设置未保存三选一可触发；
  - 宽屏遮罩计算样式为 `display:none`。
- 安装版 Electron（CDP）：
  - 窗口 `Astarray GUI`；
  - cookie `astarray_desktop_token` + `gui_csrf` 同时存在；
  - `/projects` 返回 200；
  - 导航/标签/19 分类/待处理均存在；
  - 无 Runtime 异常。

## 8. 风险

- `gui-server.ts` 仍是单文件大模板，未按第 8 节拆出 `ui/` 模块（未完成项）。
- 设置“保存并离开”通过点击当前分类已有的保存按钮并检查失败文本；复杂表单的真实保存失败路径未逐项人工验证。
- 新消息计数已加入 `chatBubbleStableKey`/`renderedBubbleIds` 稳定去重；真实流式场景未人工验收。
- 宽屏详情宽度已用 `--chat-detail-width` + `ResizeObserver` 同步主区留白；拖拽后视觉未人工验收。


