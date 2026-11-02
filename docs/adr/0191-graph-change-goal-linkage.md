# ADR-0191 图变更 ⇒ 目标联动（R133，2026-11-02）

- 状态：**已实现**（标记需重新规划 + 暂停 + 落盘；通知链路有单测）
- 来源：用户"继续"（目标联动）
- 相关：ADR-0187/0188/0189（图变更）、ADR-0144（证据失效）、ADR-0141（暂停条件）

## 1. 问题

图变更（注入/删除/修订/重连）后，目标模式完全"看不见"：V 不重算、不暂停、不要求重规划，
可能继续按旧前提推进。

## 2. 设计

1. `DagScheduler` 增加可选 `onGraphChanged(event)`：每次成功注入/删除/修订/重连后触发
   （`try/catch`，失败不阻断图变更）。
2. 控制器把事件转发为 `onMissionGraphChanged(missionId, event)`。
3. 运行时实现目标联动：
   - 通过 `goalMissionBindingStore` 查 mission 是否绑定目标；无绑定 ⇒ 不做；
   - 有绑定 ⇒ `goalGateCache.resolve(missionId)?.pause(reason, [reason])`；
   - 持久化：`requiresReplanning=true`、`pauseReason`、`evidenceGaps` 追加、
     `gateSnapshot` 同步（`isPaused/requiresReplanning/pauseReason/evidenceGaps`）。

即：**图变更 ⇒ 目标暂停并要求重新规划**（保守方向：不自动重算 V、不自动继续）。

## 3. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 13/13
  注入/重连各触发一次 onGraphChanged（事件顺序与 taskId 正确）。
tests/core --maxWorkers=2 → 471 files / 3643 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- **没有自动重算 V**（图增删与要求映射的关系未建模；需产品定语义）；
- 没有"重规划后恢复"的一键流程（需用户/宿主按 `requiresReplanning` 处理）；
- 联动**无自动化集成测试**（只测了调度器通知；目标暂停路径靠代码走查）；
- 通知是 fire-and-forget：进程在写状态前退出会丢；
- 修订/删除/注入/重连一律暂停（包括无实质影响的修订），偏保守。
