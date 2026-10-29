# ADR-0099 严格模式读取独立裁决（完成门禁生产方 R10）

- 状态：已采纳（读取侧；写入方未接）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R10
- 相关：ADR-0098（裁决存储）、ADR-0097（收据读取）、ADR-0079（完成门禁）

## 1. 背景

R9 落了裁决存储，但 `completionVerdictReader` 仍是空位 ⇒ 严格模式永远"缺裁决"，
只能一律 block。本轮把读取接上，并明确聚合口径。

## 2. 设计（冻结）

1. 运行时构造 `CompletionVerdictStore` 并提供：
   `completionVerdictReader(missionId) → { isAccepted, reasons } | null`。
2. **聚合口径**（mission 级）：
   - 该 mission **没有任何裁决** ⇒ `null`（门禁按"缺裁决"阻断）；
   - 有裁决但**存在 rejected** ⇒ `isAccepted:false`，理由带 `task: reason`；
   - 全部 `accepted` ⇒ `isAccepted:true`。
3. **不伪造**：存储缺失/损坏一律按"无裁决"处理（`null`）。
4. 裁决存储句柄 `runtime.completionVerdictStore` 一并暴露（供后续写入方/诊断）。

## 3. 生产调用链（源码位置）

```
MainController.projectMissionCompletionGate
└─ completionVerdictReader(missionId)               ← application-runtime 提供
   └─ CompletionVerdictStore.listForMission(missionId)
      └─ <state>/completion-verdicts/<mission>/<task>.json
```

## 4. 未完成（如实）

- **写入方仍未接**：`IndependentReviewGate.recordVerdict` 不写本存储。
  原因：`AgentAppointment` **没有 missionIdentifier 字段**（只有 `boundTaskIdentifier`），
  直接写入会缺 mission；需要先给 appointment 加字段（R11）。
- **聚合口径是"mission 级"**：门禁要求的是 mission 级裁决，而存储是 task 级；
  当前用"全部 accepted 才通过"，**未按任务逐一对齐**（例如某任务无裁决、其它 accepted ⇒ 会通过）。
  这是已知语义粗糙点，R11 一并收紧。
- **未运行验证**：没跑过"无裁决 ⇒ null""有 rejected ⇒ 不通过""全 accepted ⇒ 通过"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
