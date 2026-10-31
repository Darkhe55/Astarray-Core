# ADR-0149 预算耗尽按"治理停止"处理（R85，2026-10-31）

- 状态：已采纳（目标暂停已落盘；mission 终态仍有 `cancelled` 残留，见 §4）
- 来源：用户"继续"（修 R84 遗留 #1）
- 相关：ADR-0148（预算执行前守卫）、ADR-0140（组边界）、ADR-0146（完成证据）

## 1. 问题

预算守卫拒绝工具后，任务按**普通失败**收口：mission 显示 `cancelled`、目标**不会暂停**、
`consumedToolCalls` 不增。这等于"预算耗尽"看起来像偶发任务失败，而不是治理停止。

## 2. 设计（冻结）

1. **结构化失败码**：`WorkerOutcome.failure` 增加可选 `failureCode`；
   worker 在工具结果 error 时记录 `errorCode`，并在失败收口时带上；
   orchestrator 的 `catch`（运行时异常）也从 `DomainError.errorCode` 取。
2. **分流**：`handleWorkerOutcome` 的 failure 分支若 `failureCode === "tool-budget-exhausted"`：
   - 任务置 `failed`（事实保留）；
   - 升级 `目标工具调用预算已用尽，mission 停止：<原因>`；
   - 调 `onGoalBudgetExhausted(missionId, reason)`（运行时实现）；
   - `finishMission("blocked")` 并结束本分支（不再走普通失败的重试/保留路径）。
3. **目标暂停落盘**：运行时端口读绑定 → 契约/状态 → `gate.pause(reason, [reason])` →
   写状态（`pauseReason`、证据缺口、`gateSnapshot` 同步、`documentRevision+1`）。
4. **终态防覆盖**：`finishMission` 幂等（`isMissionFinished`），循环自然退出时不再写 `cancelled`
   覆盖已定的 `blocked/done`。

## 3. 真实复跑

`goal-k10c`（`maximumToolCalls:1`、`pauseConditions:["budget-exhausted"]`、`req-1→T-001`）：

```
run … --goal goal-k10c --goal-enforce
→ [目标门禁] 阻断派发：目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 writeFileTemporary。
→ [需要用户] 目标门禁在组边界拒绝继续调度: 目标工具调用预算已用尽（…）
goal-mode status --goal goal-k10c
→ isPaused: true
  pauseReason: "目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 writeFileTemporary。"
  evidenceGapCount: 1
```

即：**目标确实暂停并落盘**（修复前不会暂停）。

## 4. 仍未解决（如实）

- **mission 终态仍显示 `cancelled`**：`onMissionFinished("blocked")` 的更新是 `void`（异步），
  随后关闭/其他写入把它覆盖；已加 `finishMission` 幂等，但没抓到具体覆盖点；
- **任务因预算失败时的 `consumedToolCalls` 仍为 0**（失败组不写收据计数），与"已执行 1"不一致；
- **组边界停止的输出状态**仍是 `cancelled`；
- 预算耗尽与"真正取消"在外部仍难区分（只能靠 `goal-mode status` 的 pauseReason）。

## 5. 验证

- G5 早停续跑：2/2 通过（`finishMission` 幂等 + 状态映射未改 blocked 直映射）；
- 全量：`tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 真实复跑：目标 `isPaused` + 预算原因已落盘。
