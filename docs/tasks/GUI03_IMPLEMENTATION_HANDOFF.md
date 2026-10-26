# GUI-03 实施交接（进行中）

日期：2026-10-26。状态：implemented-unverified。F01/F03/F04/F05/F06/F07/F08/F09/F10/F11/F12 已接；F02 按用户决定保持不可启用（无实验运行时消费者）。

## 1. 已完成

- R01：五个 UI 模块已拆出并真实使用：
  - `ui/navigation.ts`
  - `ui/theme.ts`
  - `ui/settings.ts`
  - `ui/conversation-scroll.ts`
  - `ui/detail-panel.ts`
- R02：模型账户、预算“保存并离开”等待真实 Promise 的 `saved`；失败保留页面。显示开关为纯视图状态。
- R03：稳定消息键与 `renderedBubbleIds` 去重。
- R04：`--chat-detail-width` + `ResizeObserver` 同步详情与主区留白。
- F01：通知偏好（完成/失败/待处理/系统通知），`localStorage` 持久化；默认应用内开、系统关。\n- F04：项目权限覆盖在任务工具 PolicyWrapper 创建时选择。\n- F06/F10：项目/会话上下文覆盖在提示词装配时读取。
- 修复待处理页 `refreshPermissionAsks is not defined`。

## 2. 未完成 / 阻塞

| 项 | 状态 | 原因 |
|---|---|---|
| F04 项目权限覆盖 | implemented-unverified | ScopedSettingsStore + GUI + 任务 PolicyWrapper 已接 |
| F06 项目上下文覆盖 | implemented-unverified | ScopedSettingsStore + GUI + 提示词装配已接 |
| F10 会话上下文覆盖 | implemented-unverified | ScopedSettingsStore + GUI + 提示词装配已接 |
| F02 实验功能 | partial | 目录/默认关闭/存储/只读 UI；无运行时消费者，开关不可启用 |
| F05 项目工作时段 | implemented-unverified | 项目作用域存储/UI + dispatch/resume/model/tool 门禁；在途长工具收尾契约测试通过；无自动重派发 |
| F03 工具生命周期 | implemented-unverified | zip 安装/启停/升级/回退/差异 UI；真实 zip 预览/安装/不自动启用冒烟通过 |
| F07 指令队列 | implemented-unverified | FIFO/容量/手动置顶已接；无 queue/guidance/smart 模式（用户确认不需要） |
| F08 会话模型切换 | implemented-unverified | 多账户/candidate/pool/binding/applied-failed + session id 传播；fake-runtime 端到端通过 |
| F09 会话临时权限 | implemented-unverified | 列表/创建/撤销已接；真实创建未人工验收 |
| F11 任务成果记录 | implemented-unverified | 修复 mission artifact root + PolicyWrapper 产物回调；Provider 工具循环创建文件并登记 ArtifactRecordStore，端到端通过 |
| F12 参数授权编辑 | implemented-unverified | 规则明细、GUI 编辑、CAS 写入、放宽二次确认、HTTP 路由已接；真实点击未验收 |

## 3. 修改文件

- `astarray-ui/packages/gui/src/server/gui-server.ts`
- `packages/gui/src/server/ui/*.ts`
- `tests/gui/unit/ux02-gui-repair.test.ts`
- 相关旧测试断言同步到模块文件

## 4. 验证

- `npm run typecheck`：通过。
- Vitest：654 passed。
- 开发 GUI 最新 CDP 冒烟：导航、4 标签、19 分类、更多隐藏、新消息按钮、详情遮罩、通知 4 开关存在；F07 队列容量、F09 创建输入、F08 模型候选下拉可见；页面切换与 `/projects`、`/settings`、`/settings/scoped`、`/settings/model-bindings`、`/settings/model-candidates`、`/settings/session-elevations`、`/support/package/preview` 均 200；无 Runtime 异常。\n- 修复候选重复：按 provider+model 去重（同一 provider/model 的多账户候选仍需账户标识才能区分）。\n- 真实 GUI 支持包导出：`/support/package/preview` 200、`/commands/export-support-package` 200，生成 zip，未上传。\n- 真实 GUI 数据备份导出：`/settings/data-backup` 200、`/commands/export-data` 200，生成 zip；恢复未执行。\n- 真实 GUI 文件夹授权空状态：`/folder/grants` 200，返回空集合与解释；项目标识已从工作区名注入。\n- 真实 GUI 文件夹批准/撤销：request 200、approve 200（issued）、grants 可见、revoke 200，撤销后记录保留并标记。\n- 真实 GUI 数据恢复：临时状态导出后 `/commands/restore-data` 200，返回 safetyBackupPath；未在正式状态执行。\n- F11 端到端：修复 mission artifact root 与 PolicyWrapper 成功回调后，Provider 写工具创建文件并登记 ArtifactRecordStore，测试通过。\n- GUI 发送离线路径：`/commands/send-message` 202，outbox 文件生成，明确 queued-offline。\n- 安装版 CDP 冒烟（较早轮次）：导航、19 分类、待处理、cookie、/projects 200。\n- 桌面版已重建并安装到 `%LOCALAPPDATA%\\Programs\\Astarray\\Astarray.exe`；清除 `ELECTRON_RUN_AS_NODE` 后真实启动 CDP 冒烟通过：标题、设置入口、19 分类、`/projects`、`/settings`、`/settings/scoped`、模型绑定、工具包生命周期、工作时段、实验目录、`/folder/grants` 均 200，无 Runtime 异常。
- 本轮新增通知/F01 与模块拆分后未重新构建安装版。

## 5. 未验证

- 安装版最新模块拆分；
- F01 系统通知真实许可流程；
- R02 其他分类保存失败路径；
- 真实任务/成果数据；
- 人工视觉验收。

## 6. 结论

不能标记 GUI-03 完成。R01–R04 与 F01 已编码；其余能力受核心公共门面缺失阻塞。后续应先补作用域配置、会话控制、工作时段、工具生命周期与产物查询的受控公共 API，再继续 GUI 接线。

























































