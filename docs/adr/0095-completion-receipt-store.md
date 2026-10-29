# ADR-0095 完成收据的本地存储（完成门禁生产方 R6）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R6、ADR-0079 已知缺口
- 相关：`completion-receipt.ts`、ADR-0079（完成门禁）

## 1. 背景

`completion-receipt.ts` 只有**契约与纯判定**；全仓**没有任何地方写收据**。
后果：`isCompletionReceiptRequired=true` 时，完成门禁只能一律阻断（这是 ADR-0079 明确记录的
"无生产方"缺口，也是严格模式默认关闭的原因）。

## 2. 设计（冻结）

1. **落盘位置**：`<state>/completion-receipts/<mission>/<task>.json`（路径片段清洗，
   防目录穿越）；文件内容 `{ schemaVersion: 1, receipt }`。
2. **写入前校验**：复用 `evaluateCompletionReceipt`（`requiresCompletionControlEvent:false`）；
   不足 ⇒ 抛 `invalid-task-chain`，**不落盘**（不补默认收据）。
3. **不可改写**：同 mission/task 已有收据时 ——
   内容相同 ⇒ 幂等（`didWrite:false`）；内容不同 ⇒ 抛 `journal-corrupted` **拒绝覆盖**
   （防止事后改写完成证据）。
4. **原子写 + 备份**：走 `writeAtomicJson`；读取走 `readJsonWithBackupRecovery`，
   损坏返回 `null`（不伪造收据）。
5. **只存收据字段**：不存模型自述、不存正文。

## 3. 生产调用链（源码位置）

```
（R7 将由 worker 成功分支构建收据）
CompletionReceiptStore.save(receipt)          packages/core/src/orchestration/completion-receipt-store.ts
├─ evaluateCompletionReceipt（不足 ⇒ 拒绝）
├─ read 既有收据（同内容 ⇒ 幂等；不同 ⇒ 拒绝覆盖）
└─ writeAtomicJson(<state>/completion-receipts/<mission>/<task>.json)
（R8 将由 completionReceiptReader 读取）
```

当前**无生产调用方**：本模块只提供存储能力。

## 4. 未完成（如实）

- **没有写入方**：worker 成功分支尚未构建并保存收据（R7）。
- **没有读取方**：`completionReceiptReader` 尚未接本存储（R8）。
- **未运行验证**：未跑"首次写入""同内容幂等""不同内容拒绝覆盖""损坏返回 null"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
