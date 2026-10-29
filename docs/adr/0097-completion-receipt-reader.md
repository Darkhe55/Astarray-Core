# ADR-0097 严格模式读取已落盘完成收据（完成门禁生产方 R8）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R8
- 相关：ADR-0095（存储）、ADR-0096（写入）、ADR-0079（完成门禁）

## 1. 背景

R6 交付存储、R7 交付写入，但**读取端口 `completionReceiptReader` 一直是空位**：
`projectMissionCompletionGate` 在严格模式下调用它，运行时却从未提供 ⇒ 读完必然 `null`
⇒ 严格模式对"已落盘的收据"视而不见，只能一律 block。

## 2. 变更（冻结）

1. 运行时在控制器选项里提供：
   `completionReceiptReader: (missionId, taskId) => completionReceiptStore.read(missionId, taskId)`；
2. 同时补上 R7 的**装配缺口**：R7 只在调度器侧使用 `completionReceiptStore`，但运行时
   **没有把 store 传给控制器** ⇒ 调度器拿到 `null`、收据实际不会落盘。现在控制器选项里
   同时传 `completionReceiptStore` 与 `completionReceiptReader`，写读共用同一份存储。
3. 读取失败/文件不存在 ⇒ `null`（沿用存储的"不伪造收据"规则），门禁按"无收据"处理。

## 3. 生产调用链（源码位置）

```
ApplicationRuntime 构造                                   packages/core/src/application/application-runtime.ts
├─ new CompletionReceiptStore({baseDirectory: stateDirectory})
└─ MainController 选项：
   ├─ completionReceiptStore   → AssistScheduler / DevolveScheduler（worker success 落盘）
   └─ completionReceiptReader  → projectMissionCompletionGate（严格模式读取）
      └─ completionReceiptStore.read(missionId, taskId)
```

## 4. 未完成（如实）

- **严格模式仍可能 block**：只有"worker 提供了收据且已落盘"才可能通过；没有收据时仍阻断
  （这是既定 fail-closed，不是缺陷）。
- **独立裁决读取仍空位**：`completionVerdictReader` 没有实现（R9–R10）。
- **没有重算**：读取只返回存储内容，不与真实产物/工具计数交叉核对。
- **未运行验证**：没跑过"已落盘 ⇒ 门禁可读""未落盘 ⇒ 门禁视为无收据"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
