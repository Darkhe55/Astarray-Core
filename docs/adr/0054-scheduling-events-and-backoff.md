# ADR-0054 事件驱动唤醒、有界退避与失败重派上限（ALIGN-02-07）

- 状态：部分采纳（循环语义与两个事件源已接；逐任务事件源未接）
- 日期：2026-10-28
- 来源：[ALIGN-02](../tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md) 检查点 07
- 相关：ADR-0049（序列先于 mission）、ADR-0052（领取与派发）

## 1. 背景

卡内要求：持续调度由**就绪、完成、依赖解锁、时段恢复、资源释放**事件唤醒；无进展有界退避；
没有工作时不忙轮询；失败不形成无限重派。

实测：`waitForNextWake(maximumWaitMilliseconds)` 只有一个固定超时（调用方若用短超时就是忙轮询），
`wake()` 不告诉调用方"为什么醒"，而且派发失败后任务被放回 `pending`，
**下一轮会立刻再次领取** —— 失败次数无上限，构成无限重派。

## 2. 契约（冻结）

1. **唤醒必须带原因**：`SchedulingWakeReason = external | task-ready | task-finished |
   dependency-unlocked | work-window-resumed | resource-released`；
   `waitForNextWake` 返回 `SchedulingWakeReport { reason, waitedMilliseconds }`，
   超时如实返回 `timeout`（不把超时伪装成事件）。
2. **有界退避**（`getRecommendedWaitMilliseconds`）：
   - 上一轮**完全没有可执行任务** ⇒ 空闲等待 30 s（**不忙轮询**）；
   - 有进展 ⇒ 1 s（尽快继续下一组）；
   - 连续无进展 ⇒ `250 ms × 2^(n-1)`，封顶 30 s。
3. **失败不无限重派**：同一任务连续派发失败达 `MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK = 3`
   ⇒ 停止自动重派，`skippedReasons` 写明"等待状态变化或人工介入"；
   成功派发即清零；外部状态变化后可由调用方 `resetDispatchFailureCounts()` 重新允许。
4. **进展统计**：`consecutiveNoProgressRoundCount` 在有派发时清零、否则累加，
   随每轮结果返回（可观测，不靠猜）。
5. **事件源**（当前已接）：mission 创建并启动调度 ⇒ `task-ready`；
   mission 终态（assist 收口 / devolve 完成）⇒ `task-finished`。
6. **未注册派发处理器不算"无进展"**：那是配置缺失，`blockedReason` 已单独表达，
   不参与退避计数（避免把配置问题误当调度停滞）。

## 3. 生产调用链（源码位置）

```
mission 启动
└─ MainController.handleUserMessage → launch* → notifySchedulingEvent("task-ready")   packages/core/src/orchestration/main-controller.ts
mission 终态
├─ AssistScheduler.onReportToMain（完成）→ notifySchedulingEvent("task-finished")
└─ DevolveScheduler.onMissionFinished   → notifySchedulingEvent("task-finished")
调度方
└─ SecondaryContinuousDispatchLoop                                                   secondary-continuous-dispatch-loop.ts
   ├─ runRound：失败计数/达上限停手、进展统计、建议等待
   └─ waitForNextWake(max)：返回 { reason, waitedMilliseconds }（超时=timeout）
```

## 4. 未完成（如实）

- **循环仍无真实派发端点**（承接 ADR-0052）：事件唤醒了"调度方"，但调度方还不会真的派发。
- **逐任务事件源未接**：没有"某任务完成 / 依赖解锁 / 时段恢复 / 资源释放"的发布点；
  目前只有 mission 级两个事件。
- **退避未与真实时钟和取消联动**：`waitForNextWake` 仍由调用方给定上限，
  取消/关闭只通过 `stop()` 置位。
- **未实测**：没有跑过"连续失败 3 次后停手"、"无进展退避序列"、"空闲等待"的任何一次真实计时。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
**不宣称**"调度已事件化/不再忙轮询"——生产侧还没有常驻调度循环在跑。
