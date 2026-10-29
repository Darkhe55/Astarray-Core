# ADR-0096 Worker 成功收据落盘（完成门禁生产方 R7）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R7
- 相关：ADR-0095（收据存储）、ADR-0079（完成门禁）

## 1. 背景

`worker-agent` 成功分支**早已**用真实本地状态构造 `CompletionReceipt`
（工具调用数 `toolCallsByCallId.size`、落盘产物 `persistedArtifactPaths`、完成事件校验结果），
但**编排层从不落盘**：`handleWorkerOutcome` 只在严格模式下读 `outcome.completionReceipt` 判充足性，
通过后即丢弃。⇒ 严格模式的"收据"只有瞬时值，事后无法审计，也无法被读侧复用。

## 2. 变更（冻结）

1. `MissionOrchestratorOptions` 新增 `completionReceiptStore?: CompletionReceiptStore | null`
   （缺省 null ⇒ 不落盘，行为不变）；
2. `handleWorkerOutcome` 的 `success` 分支：**先落盘再走门禁**；
   - 只保存 worker 给的收据，**不修改内容、不补默认收据**；
   - 落盘失败**不改变完成判定**，但通过 `onUserEscalation` 如实升级
     （避免"收据丢了"被静默吞掉）；
3. `MainControllerOptions` 同名选项，透传给 assist / devolve 两个调度器；
4. 运行时构造 `<state>/completion-receipts/` 的存储并暴露句柄。

## 3. 生产调用链（源码位置）

```
WorkerAgent 成功分支（既有）                          packages/core/src/orchestration/worker-agent.ts
└─ outcome.completionReceipt（真实本地状态构造）
   └─ MissionOrchestrator.handleWorkerOutcome("success")   mission-orchestrator.ts
      ├─ completionReceiptStore.save(receipt)  ← 本步（失败 ⇒ 升级提示）
      └─ isCompletionReceiptRequired ? evaluateCompletionReceipt : 跳过
MainController → AssistScheduler / DevolveScheduler 透传 completionReceiptStore
ApplicationRuntime：new CompletionReceiptStore({baseDirectory: stateDirectory})
```

## 4. 未完成（如实）

- **读取侧未接**：`completionReceiptReader` 仍是外部注入的空位（R8）。
- **严格模式仍会阻断**：没有收据（worker 未给）时依旧 blocked；本步只保证"给了就存"。
- **没有本地校验落盘内容与真实产物的一致性**：收据字段来自 worker 本地状态，但编排层**不重算**。
- **未运行验证**：没跑过"成功带收据 ⇒ 落盘""落盘失败 ⇒ 升级且不判 done"
  "同任务重复落盘 ⇒ 幂等""不同内容 ⇒ 拒绝覆盖"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
