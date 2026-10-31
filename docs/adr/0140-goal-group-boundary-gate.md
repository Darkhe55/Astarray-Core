# ADR-0140 组边界门禁复查（K10，2026-10-31）

- 状态：已采纳（**仅强制模式装配**；无集成测试）
- 来源：用户"继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K10
- 相关：ADR-0092（解析器）、ADR-0139（完成耦合）

## 1. 背景

门禁此前**只在 mission 启动前**评估一次（`launchAssistMission` / `launchDevolveMission`）。
mission 一旦跑起来，即使目标暂停、需重规划或超期，调度器也会继续派发 ——
"遇到阻塞自动停止"不成立。

## 2. 设计（冻结）

1. `MissionOrchestratorOptions.goalGroupBoundaryGatePort?`：
   在 `runLoop` 的**安全点**（`inFlightTaskIds.size === 0`）**每轮复查一次**。
2. 不通过 ⇒ `onUserEscalation(原因)` + `finishMission("blocked")` + **return**（不再调度）；
   端口**抛错也保守停止**（宁可停，不误跑）。
3. 控制器 `buildGoalGroupBoundaryGatePort(missionId)`：
   - **只有 `isGoalModeEnforcementEnabled === true` 且装配了 resolver 才提供端口**；
   - 复用 `observeGoalDispatchGate`：判定**照常落盘/流式输出**，`isBlocked` ⇒ 停止。
4. **默认（强制关）不装配**：行为与今天一致（只观察、不停任务）。

## 3. 调用链（源码位置）

```
MissionOrchestrator.runLoop                        mission-orchestrator.ts
└─ 无在途任务 ⇒ goalGroupBoundaryGatePort()
   └─ MainController.observeGoalDispatchGate（判定 + 落盘 + 输出）
      └─ 不通过 ⇒ finishMission("blocked") + return
```

## 4. 未完成（如实）

- **无集成测试**：真实 mission 在组边界被停止的路径、blocked 状态落盘、与 Git 集成/恢复的交互都未验证；
- **每轮都查**：安全点轮询频率高（每次 scheduleRound 前），没有节流；性能未测；
- **只受强制开关控制**：默认关 ⇒ 仍是"只观察"，不会自动停；
- **停止语义**：`finishMission("blocked")` 会走既有收口（含 Git 集成收尾），但没有"暂停后可恢复"的入口；
- **依赖 V/暂停准确性**：若 `pause()` 误触发（如映射缺失导致 V 不降），强制模式下会真的停任务。

## 5. 验证状态

**implemented-unverified**（`typecheck`/`lint`/`build` 通过；无单测覆盖该端口）。
