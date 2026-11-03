# ADR-0207 工作时段受控自动恢复闭环（GUI-04-06，2026-11-03）

- 状态：**已实现**
- 来源：GUI-04 §1「时段门禁没有自动恢复闭环」
- 相关：ALIGN-04-04（`evaluateWorkWindowResume` / `handleWorkWindowResume`）、WORKWINDOW-01-03

## 1. 问题

`handleWorkWindowResume` 与恢复判定早已实现，但**全仓没有调用方**：
时段门禁拒绝后 mission 直接失败，rest→working 也不会恢复——"闭环"缺失。

## 2. 实现

| 层 | 内容 |
|---|---|
| 记账 | `WorkWindowDeferredMissionStore`（`work-window/deferred-missions.json`）：同一 mission 去重，保留首次登记时间 |
| 登记点 | 派发门禁拒绝、恢复门禁拒绝、运行期 `wrapRuntimeForWorkWindow` 拒绝三处均登记 |
| 恢复 | `resumeDeferredWorkWindowMissions`：按登记顺序逐条调用 `handleWorkWindowResume`（`pauseKind: "rest"`）；成功或已在运行 ⇒ 移除；被拒/异常 ⇒ 保留下次再试 |
| 触发 | 时段检测器 `onRestToWorking` ⇒ 先自动恢复，再调用宿主可选回调；默认开启，可用 `isWorkWindowAutoResumeEnabled: false` 关闭 |
| 宿主 | GUI 启动参数显式 `isWorkWindowResumeMonitorEnabled: true`（运行时默认仍不排定时器） |
| 门面 | `PublicApplicationOptions` 透传两个开关 |

## 3. 验证

```
tests/core/work-window-deferred-resume.test.ts → 3/3（去重、删除、成功/已运行移除、被拒/异常保留、顺序）
tests/core/integration/work-window-deferred-recording.test.ts → 1/1（全天休息 ⇒ 任务被拒且落盘登记）
私有库 gui04-06-work-window-resume.test.ts → 1/1（GUI 显式开启检测器）
公开全量（串行）：500 files / 3690 tests 通过；私有库 98 files / 674 tests 通过
```

## 4. 未完成

- **rest→working 的端到端**（真实跨时段 + 检测器定时触发）未做；本轮只验证"拒绝→登记"与恢复纯语义；
- 恢复被拒的 mission 只保留登记，没有退避/上限与告警面板；
- 人工暂停不登记（符合卡内"手动取消不复活"），但未加专门反例；
- 多进程同时触发恢复未加锁（依赖 `already-running` 与登记移除，仍可能双触发后一者被拒）。
