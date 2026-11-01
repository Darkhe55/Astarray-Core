# ADR-0185 按 taskId 派发（有界实现，R126，2026-11-01）

- 状态：**有界实现完成**（调度器/编排器/控制器/门面；无 CLI，按既有纪律）
- 来源：用户"做 §B1"
- 相关：ADR-0110（预检仍拒绝）、ADR-0052（结构性缺口）、ADR-0174（同进程指令）

## 1. 能力边界（先说清不做什么）

"按 taskId 派发"**不是**：绕过依赖、运行中改图、抢占在跑的任务、跨进程操控。
本次实现的是：**在可运行任务之间，按用户指定的 taskId 调整启动顺序**。

硬约束（拒绝而非放宽）：
- 任务必须存在；
- 状态必须 `pending`（`blocked`/`failed` 需先 retry/reassign）；
- 依赖必须全部 `done`；
- 已运行/已领取的任务不能再次派发。

## 2. 实现

| 层 | 内容 |
|---|---|
| `DagScheduler.preferTaskDispatch` | 校验后把 taskId 放入 `preferredDispatchTaskIds`；`scheduleRound` 排序时优先，启动后移除 |
| `MissionOrchestrator.dispatchTaskByTaskIdentifier` | 调调度器，接受则 `wake()` 立即触发下一轮 |
| `MainController.dispatchMissionTask` | 仅同进程运行中的 mission；否则 `mission-not-active` |
| 门面 `dispatchMissionTask` | 对外 API（宿主/TUI/GUI） |

**未加 CLI**：与 ADR-0174 同理——headless 另一个进程拿不到 activeOrchestrator，
加 CLI 会显示"mission-not-active"，误导用户。

## 3. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 3/3
  优先启动（t2 先于 t1）；依赖未完成拒绝；不存在/已运行拒绝。
tests/core/goal-mission-instruction.test.ts → 2/2（门面拒绝非活动 mission）
tests/core --maxWorkers=2 → 471 files / 3633 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成 / 仍是缺口

- **乱序派发**（依赖未完成时强行启动）**仍不支持**——这是 ADR-0052 的结构性限制；
- **抢占/暂停在跑任务**不支持；
- **跨进程**不支持（租约隔离）；
- 没有"派发结果回执/事件"（只返回同步判定）；
- `TaskLedgerBridge.requestDispatchByTaskIdentifier` 仍返回 `refused-unsupported`
  （它服务的是"序列→mission"写入同步，不是本能力）；
- 没有真实 mission 的端到端演练（需要 TUI/宿主同进程触发，headless CLI 不适用）。
