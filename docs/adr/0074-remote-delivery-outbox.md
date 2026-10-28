# ADR-0074 幂等投递 outbox 与 unknown 语义（REMOTE-01-03）

- 状态：部分采纳（outbox + 回执判定 + 目标不可变；无真实传输适配器）
- 日期：2026-10-28
- 来源：[REMOTE-01](../tasks/REMOTE01_SCOPED_RUN_EVIDENCE_EXPORT.md) 检查点 03
- 相关：ADR-0073（绑定与双步骤）、ADR-0070（外发门禁）

## 1. 背景

在本检查点之前，投递只有一句"端口必须幂等"的注释：没有稳定 operation id、
没有回执读取、没有 unknown 状态、也没有"目标不可改"的约束。
一旦平台受理但未送达，调用方会把"已受理"当成"已送达"（最危险的谎报）。

## 2. 契约（冻结）

1. **稳定标识**：`operationIdentifier`（服务端生成、重试不变）+ `interactionRevision`（同一请求
   的修订必须递增）+ `contentHash` + `authorizationRevision`（授权变化后旧 operation 不得复用）。
2. **不完整不发送**：`validateRemoteDeliveryOperation` 逐项校验必填/格式/长度/
   `sha256:<64 hex>` 哈希/授权 revision；不完整 ⇒ `enqueue` 直接抛错，**不发送**。
3. **入队幂等**：同 `operationIdentifier` 同内容 ⇒ 返回既有记录（`wasEnqueued:false`）；
   **同 id 不同内容/目标/修订 ⇒ 拒绝**（防"换内容复用同一 operation"）。
4. **先读回执**：`attemptRemoteDelivery` 先 `readReceipt`；
   - 明确 `acknowledged` ⇒ `sent`（不重发）；
   - 无回执且端口"已受理" ⇒ **`unknown`**，**绝不**记成 `sent`；
   - `unknown` 状态下只有调用方**显式** `isResendAfterUnknown` 才重发（不自动重试）。
5. **目标不可变**：`assertRemoteDeliveryTargetUnchanged` —— 已入队 operation 的账户/设备不可改；
   换目标必须新 operation + 新授权（**不自动换目标**，也不降级到公开链接/邮件）。
6. **落盘**：`<state>/remote-delivery/outbox.json`（原子写 + 互斥 + 备份恢复）。

## 3. 生产调用链（源码位置）

```
RemoteEvidenceExportService.deliverEvidenceExport        remote-evidence-export.ts
├─ 范围复核（ADR-0073）
├─ RemoteDeliveryOutbox.enqueue（完整性 + 幂等）           remote-delivery-outbox.ts
└─ attemptRemoteDelivery
   ├─ outbox.find → 状态判定（sent/refused/unknown）
   ├─ transport.readReceipt（**先读回执**）
   ├─ transport.send（端口按 operation id 幂等）
   └─ 读回执 → sent | unknown（无明确回执一律 unknown）
```

## 4. 未完成（如实）

- **没有真实传输适配器**：`RemoteDeliveryTransportPort` 只有契约；IM 平台发送/回执读取未实现，
  所以"回执"目前只能是测试注入或本地假实现。
- **没有定时重试/退避**：`unknown` 的重新尝试完全靠调用方显式触发；没有调度器。
- **没有 unknown 处置入口**：没有 CLI/UI 让用户"读回执/确认重发/取消"，
  只有本模块的 API。
- **`authorizationRevision` 由调用方提供**：登记绑定时的 revision 语义（何时递增）尚未固化。
- **没有与主控制面接线**：运行时未构造 outbox/transport；投递链路仍未可运行。
- **未验证**：没有跑过"重复入队""同 id 换内容被拒""受理后无回执 ⇒ unknown"
  "unknown 不自动重发""换目标被拒"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收；无真实 IM 平台。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
