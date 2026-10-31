# ADR-0153 治理停止被写成 cancelled 的真凶：assist 状态解析（R89，2026-11-01）

- 状态：**已定位并修复**（CLI 与持久化 summary 都已是 `blocked`）
- 来源：用户"做"（要求给终态写入加追踪）
- 相关：ADR-0149/0150/0151/0152（同一条问题的连续追查）

## 1. 追踪手段

`ASTARRAY_TRACE_MISSION_STATUS=1` 时：
- `MissionManager.updateMissionStatus` 打印 `[MSTATUS]` + 调用栈（每次终态写入）；
- `MissionOrchestrator.finishMission` 打印 `[FTERM] requested=<status> hasFailed=<bool> finished=<bool>`。

追踪输出（决定性）：

```
[FTERM] mission=mission-a38144af requested=blocked hasFailed=true finished=false
[MSTATUS] mission=mission-a38144af status=cancelled
    at MissionManager.updateMissionStatus
    at MainController.finalizeMissionStatus
    at AssistScheduler.finishMission
    at AssistScheduler.handleWorkerOutcome
```

即：编排器**要求写 blocked**，落库却变成 **cancelled**。

## 2. 真凶

`AssistScheduler` 把终态包装成主 Agent 报告（`onReportToMain`，文本 `任务完成状态: <status>`），
控制器原来的解析是：

```ts
const status = instructionText.includes("done") ? "done" : "cancelled";
```

⇒ **`blocked` 被当成 `cancelled`**（"不是 done 就算取消"）。此前所有"mission 终态 cancelled"
的追查（ADR-0149→0152）都绕在这一行外面。

修复：显式解析 `任务完成状态:` 后的值，只有 `done`/`blocked`/其他（=cancelled）三种；
`blocked` 走既有终态单点写 blocked。

## 3. 真实复跑（goal-k10p，上限 1）

```
run … --goal goal-k10p --goal-enforce
→ {"missionId":"mission-1ecd691c","status":"blocked"}
summary.json → status: blocked   ← 第一次 CLI 与磁盘一致
```

目标侧同时正确：`isPaused: true`、`consumedToolCalls: 1`、pauseReason 保留。

## 4. 验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 真实复跑：CLI `blocked`，持久化 `blocked`。

## 5. 遗留

- 追踪开关保留（`ASTARRAY_TRACE_MISSION_STATUS=1`，缺省关闭），供以后排查终态问题；
- `permissionAsk: requires-human-resubmission` 仍在无权限询问时出现（映射遗留，未修）；
- accepted 裁决路径、模型自主提议仍未跑过。
