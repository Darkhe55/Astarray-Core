# ADR-0174 调度器指令门面入口（R113，2026-11-01）

- 状态：已采纳（门面 API + 单测；**不提供 CLI**，原因见 §3）
- 来源：用户"继续"；卡内"用户仍能中断/返工"的可操作入口
- 相关：ADR-0140（组边界）、ADR-0171（恢复）、ADR-0162（rework 单测）

## 1. 改动

公开门面新增：

```ts
sendMissionInstruction(missionIdentifier: string, instructionText: string): void
```

委托 `MainController.sendSchedulerInstruction`（TUI 内指令同一入口）；
支持 `unblock` / `retry` / `cancel` / `reassign` 等既有指令语义，**模型不可调用**。

## 2. 真实约束：仅同进程有效

指令只发给**本进程** `activeOrchestrators` 里的调度器；headless `run` 结束后进程退出，
另一个 CLI 进程发指令**不会送达**（mission 由租约隔离）。因此：

- **没有加 `goal-mode instruct` CLI**——加了会给人"跨进程能操控"的错觉；
- 该 API 面向 TUI/GUI/嵌入宿主（同进程操作）。

## 3. 验证

```
tests/core/goal-mission-instruction.test.ts → 1/1
  没有活动调度器时发送指令是安全 no-op（不抛错）
tests/core --maxWorkers=2 → 471 files / 3607 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- **真实 rework 组仍未演练**：需要"同进程发 retry → 下一组以 rework 性质启动"的闭环，
  当前 headless CLI 无法在同一进程内注入指令；
- 指令没有回执/结果确认（`void`，失败仅内部流式输出）；
- 未做 TUI/GUI 侧的实际调用接入（属另一仓库）。
