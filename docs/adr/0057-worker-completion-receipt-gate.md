# ADR-0057 Worker 完成收据与编排层完成门禁（ALIGN-03-03）

- 状态：部分采纳（收据 + 门禁已接，默认关闭；`LocalCompletionVerifier` 仍未调用）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 03
- 相关：ADR-0015（完成事件不是充分条件）、ADR-0055（独立审查）

## 1. 背景

卡内要求：**真实工具结果、产物记录和明确完成标识进入本地完成门禁**；失败/中断只报告原因，
不伪造 done；早停从已登记检查点有界续跑，不拿下一组任务掩盖未完成组。

实测：

- `LocalCompletionVerifier`（八条本地条件）**零调用方**——它从未在任何生产路径上被执行；
- Worker 自己在本地检查"完成控制事件是否存在""写工具是否全部成功""产物是否落盘"；
- 但**编排层**只要拿到 `outcome: "success"` 就直接 `finishTask(taskId, "done")`，
  中间没有任何**可核对的收据**跨边界传递；worker 的检查结论对编排层不可见。

早停有界续跑（G5）与"失败只报原因"已在既有实现中（`isCheckpointResumeEnabled` 最多 2 次；
失败路径只置 failed/blocked），本轮未改动。

## 2. 契约（冻结）

1. **收据来自真实本地状态**：`CompletionReceipt` 的字段（是否校验完成控制事件、
   实际工具调用数、实际落盘产物路径）由 Worker 从本地状态构造，**不采信模型自述**。
2. **缺失即不足**：编排层要求收据时，`receipt === null` ⇒ 不足；**不补默认收据**。
3. **矛盾即不足**：要求完成控制事件而收据未声明已校验、或收据含空产物路径、或计数非法
   ⇒ 不足。
4. **不足时不判 done**：任务置 `blocked` 并升级原因（"完成收据不足，未判 done: …"），
   **不**写 done、**不**用下一组任务掩盖。
5. **默认关闭**：`isCompletionReceiptRequired` 缺省 `false`（未实测的收口变更不默认推送）。
6. **既有行为不变**：失败/中断路径、G5 早停续跑、Git 审查顺序均未改动。

## 3. 生产调用链（源码位置）

```
Worker 成功分支（本地门禁已过：完成事件存在 + 写工具全部成功）
└─ buildCompletionReceipt({missionId, task.id, hasVerifiedCompletionControlEvent,
                          toolCallCount, artifactPaths})          packages/core/src/orchestration/worker-agent.ts
   └─ outcome.success.completionReceipt
编排层 success 分支
└─ evaluateCompletionReceipt({receipt, requiresCompletionControlEvent})  completion-receipt.ts
   ├─ 不足 ⇒ dagScheduler.blockTaskForHumanDecision + onUserEscalation（不判 done）
   └─ 足 ⇒ 原 Git 审查 → finishTask("done")
装配
└─ application-runtime / MainController：isCompletionReceiptRequired（缺省 false）→ MissionOrchestrator
```

## 4. 未完成（如实）

- **默认关闭**：生产收口仍是"success 即 done"（没有收据要求）。
- **`LocalCompletionVerifier` 仍未调用**：本检查点用的是**收据门禁**，而不是那个八条件验证器；
  要让验证器真正生效，需要把解析后的 `TaskCompletionEventV1` 从 Worker 传到编排层
  （当前 Worker 只校验、不外传），这是 03-03 的后半。
- **收据不含**：待处理权限请求数、未确认反馈数、任务链 revision、活锁/预算状态
  —— Worker 侧拿不到这些编排层状态。
- **未接产物验收门禁**：收据只带落盘路径，"产物内容是否符合验收门禁"仍由其他路径判定。
- **未验证**：没跑过"无收据 ⇒ blocked""收据矛盾 ⇒ blocked""收据齐备 ⇒ done"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
