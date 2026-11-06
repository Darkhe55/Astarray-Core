# B6R-04b：TUI 权限组控制面（B6R-04 后继卡）

> 状态：**implemented-unverified（2026-11-06）**——核心生命周期 + TUI 面板交互已交付；真实 TTY 人工验收未做
> 编制日期：2026-08-16
> 适用提交：`5609ed1`（B6R-04 CLI 控制面已完成）
> 对应整改项：AR-06F / AR-06G
> 执行主体：OpenCode、受控次级 Agent 与受控三级 Agent
> 拆卡原因：B6R-04 生产文件已达 8 个上限，TUI 编辑页独立成卡，遵守"一次一张卡"纪律。

## 1. 目标

B6R-04 已交付 Headless CLI 完整权限组生命周期。本卡把同一认证设置控制面接入 TUI：
权限组列表/详情、当前组切换、创建/复制/重置/删除入口与逐项三态查看；
头栏显示当前权限组；不把设置控制器暴露为 Agent 工具。

## 2. 任务链

1. `MainController` 增加只读控制面方法：`getCurrentPermissionProfileReference()`、
   `listPermissionProfiles()`、`switchPermissionProfile(reference)`（认证设置控制面，
   非模型工具）。
2. `bootstrapCli` 装配 `CurrentPermissionSelectionStore` 并把当前引用传入 TUI 状态。
3. `AppState` 增加 `permissionProfileReference` 与 `permissionProfiles` 字段；
   状态轮询只读刷新（不打断输入）。
4. TUI 头栏显示当前权限组（显示名快照）；新增权限组面板（分页/虚拟列表、
   当前组标记、Unicode 长名称、搜索过滤）。
5. 面板内操作入口：切换当前组、创建（来源选择）、复制、重置、删除（当前组
   保护提示）——经认证控制面调用，不新增 Agent 工具。
6. 组件测试覆盖 80×24、120×40、60×20 尺寸、CJK/emoji 长名称、搜索与分页。

## 3. 完成条件

- 安装 tarball 后 TUI 可查看并切换当前权限组；重启后 ID/revision 保持。
- 面板不显示内部执行层、不显示 Ponder 编辑控件；Ponder 仅作为不可编辑选择项。
- 设置控制器不作为 Agent 工具注册；Agent 无法调用权限组控制面。
- 尺寸/长名称/搜索/分页组件测试通过；`npm run check` 通过。

## 4. 统一交付格式

按 `BATCH6_REPAIR_TASK_CARDS.md` §5 交付 `ASTARRAY_TASK_COMPLETION_V1`，
附 changedProductionFiles/changedTestFiles/executedChecks/coverageEvidence/
remainingRisks/completionGate。

## 5. 禁止事项

- 不修改 B6R-01~04 已验收行为；不引入新的数量配额或内部执行层披露。
- 不把设置控制面注册为模型工具；headless 契约维持不变。

## 6. 进展（2026-11-06）

已核对：`getCurrentPermissionProfileReference` / `listPermissionProfiles` / `switchPermissionProfile`
早已存在并导出到 SDK；外部 TUI 也已有头栏显示与只读权限组面板。

本轮补齐**核心生命周期控制面**：

- `MainController.createPermissionProfile` / `resetPermissionProfile` / `deletePermissionProfile`
  （复用 CLI 已使用的 `CustomPermissionProfileController`；名称唯一、来源校验、备份、
  内置/当前组删除保护均由该控制器负责）；
- 公开 SDK 同步导出三个方法；
- 证据：`permission-profile-lifecycle-production.test.ts` 3/3
  （创建/列表/重置/删除、重名拒绝、内置删除拒绝、当前组删除拒绝、
  切换持久化重启仍生效、切到不存在组拒绝）。

**仍未完成（TUI 交互）**：外部 TUI 面板当前是只读展示，缺少
"面板内切换/创建/复制/重置/删除、搜索与分页交互、80×24/120×40/60×20 组件测试"。
