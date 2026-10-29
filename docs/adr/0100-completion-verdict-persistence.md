# ADR-0100 独立裁决落盘：任命补 mission + 通过校验后写入（完成门禁生产方 R11）

- 状态：已采纳（写入侧已接；任务级聚合仍待收紧）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R11
- 相关：ADR-0098（裁决存储）、ADR-0099（裁决读取）、`IndependentReviewGate`

## 1. 背景

R9/R10 让裁决能存能读，但**没有写入方**：`IndependentReviewGate.recordVerdict`
只写既有验收门禁（内存），不写 `CompletionVerdictStore`。根因是
`AgentAppointment` **没有 mission 字段**（只有 `boundTaskIdentifier`），裁决无法按 mission 分目录。

## 2. 变更（冻结）

1. `AgentAppointment` 新增 `missionIdentifier: string | null`；
   `createAppointment` 接受可选 `missionIdentifier`（缺省 `null`，**不按任务名推断**）。
2. `IndependentReviewGate.appoint` 把输入的 `missionIdentifier` 写进任命。
3. `IndependentReviewGate` 构造可注入 `completionVerdictStore`；
   `recordVerdict` 在**三类既有校验全部通过后**（非自审、证据非纯自报、理由非空）
   写入裁决：
   - `merge-ready` ⇒ `accepted`（理由作为单条 reason）；
   - `rework` / `blocked-human-review` ⇒ `rejected`（理由 = `verdict:<raw>` + 原理由）；
   - 裁决者 = 验收者个体标识、时间 = 裁决时间。
4. **任命没有 mission ⇒ 不落盘**（旧任命/独立工作流场景），不伪造 mission。
5. `MainController` 新增 `completionVerdictStore` 选项并传给门禁；运行时注入同一份存储。

## 3. 生产调用链（源码位置）

```
MainController.recordAcceptanceVerdict
└─ IndependentReviewGate.recordVerdict            packages/core/src/orchestration/independent-review-gate.ts
   ├─ 校验：非自审 / 证据非纯自报 / 理由非空
   ├─ AcceptanceVerdictGate.recordVerdict（既有）
   └─ CompletionVerdictStore.save（本步；任命无 mission ⇒ 跳过）
      └─ <state>/completion-verdicts/<mission>/<task>.json
运行时：new CompletionVerdictStore → MainController 选项 → 门禁构造
```

## 4. 未完成（如实）

- **任务级聚合未收紧**：`completionVerdictReader` 仍是 mission 级"全 accepted 才通过"，
  某任务无裁决时仍可能通过（R12 收紧为逐任务对齐）。
- **旧任命没有 mission**：`standalone-workflow-runner` 的任命不传 mission ⇒ 其裁决不落盘。
- **裁决落盘失败会抛错**：`save` 的 `journal-corrupted`/IO 错误会冒泡，
  可能让"验收门禁已记录、存储未落盘"出现不一致（未做事务/补偿；如实记录）。
- **未运行验证**：没跑过"merge-ready ⇒ accepted 落盘""rework ⇒ rejected 落盘"
  "同内容幂等""不同内容拒绝覆盖"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
