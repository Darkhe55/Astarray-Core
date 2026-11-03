# ADR-0205 会话作用域覆盖按稳定会话解析（GUI-04-04，2026-11-03）

- 状态：**已实现**（核心解析 + GUI 会话标识统一）
- 来源：GUI-04 §1「会话配置分别使用 GUI session 与 mission ID」
- 相关：GUI-03-02（作用域配置）、ALIGN-01（稳定会话）

## 1. 问题

- 运行时读取会话上下文覆盖时用 `scoped.sessions[input.missionId]`；
- GUI 面板写入时用 `window.__astarraySessionId || chatState.selectedMissionIdentifier`。

两侧键不一致 ⇒ 会话级预算覆盖可能"写了不生效"，且 mission 被当成会话。

## 2. 修复

- 新增纯函数 `resolveScopedContextOverride({document, projectIdentifier, conversationIdentifier})`：
  **会话覆盖优先于项目覆盖**；只认稳定会话标识；缺会话时回退项目；
  **missionId 不能顶替会话**。
- 运行时 `contextPromptProvider` 改用 mission 摘要里的 `conversationIdentifier`，
  不再把 `missionId` 当会话键。
- GUI 三处 `sessionId()` 去掉 `|| selectedMissionIdentifier` 回退：无会话标识时显示"请先选择会话"，
  不再拿 mission 顶替。

## 3. 验证

```
tests/core/orchestration/scoped-settings-store.test.ts → 9/9
  新增：会话覆盖优先、缺会话回退项目、missionId 不能顶替
tests/core --no-file-parallelism → 496 files / 3677 tests 通过
外部仓库 npm run check → 94 files / 670 tests 通过
（默认并发下出现过负载相关超时；受影响文件单跑均通过，最终以串行为准）
```

## 4. 未完成

- 会话级**权限**覆盖是否也按会话键读取，未逐条核对（本次只修上下文预算）；
- GUI 无"会话选择器"时相关面板只能提示，不自动选最近会话；
- 真实浏览器人工体验未做。

## 5. 追加审计（2026-11-04）：会话级**权限**覆盖仍未消费

- 运行时仅把 `scoped.projects[projectIdentifier].permission` 接进权限组解析
  （`createPolicyWrapperForAgent`）；`scoped.sessions[...]` 的权限覆盖**没有读取方**。
- 原因：该工厂是**同步**函数，只拿到 `projectIdentifier`/`missionIdentifier`，没有稳定会话标识；
  若按 missionId 读取又会重犯本 ADR 修复的"mission 当会话"缺陷。
- 结论：GUI 可以写会话权限覆盖，但当前不会生效。**不得**把它当作已生效功能；
  后续需在任务启动时把 conversationIdentifier 解析好并传入策略层（异步预解析），或提供异步权限组 provider。
- 本 ADR 的上下文预算修复不受影响（已有 `resolveScopedContextOverride`）。

## 6. 2026-11-04 接线：会话权限覆盖已消费

- 新增纯函数 `resolveScopedPermissionOverride`（会话优先、缺会话回退项目、mission 不得顶替）；
- 控制器在 worker 工具端口工厂中传入 `missionConversationIdentifiers.get(missionId)`
  （稳定会话标识，不是 missionId）；
- 策略工厂用该标识解析会话权限覆盖，再回退项目覆盖；
- 验证：解析器单测（会话优先/回退项目/mission 不替代）；公开库全量 **598 files / 4193 tests** 通过。
- 仍受既有不可配置安全不变量与权限组校验约束。
