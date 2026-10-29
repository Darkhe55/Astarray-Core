# ADR-0079 完成门禁：任务链完成 + 收据 + 独立裁决（接线缺口第 ② 项）

- 状态：部分采纳（assist 路径已接；**收据/裁决生产方已于 R6–R12 接入，见 §7 更新**；
  devolve 路径同样拿到 `completionReceiptStore`；严格开关仍默认关闭）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ② 项
- 相关：ADR-0060（独立审查门禁）、`completion-receipt.ts`

## 1. 背景（实测）

`onReportToMain` 的完成分支此前是：

```ts
const status = instructionText.includes("done") ? "done" : "cancelled";
// 直接 release + onMissionFinished + updateMissionStatus(status)
```

**只要文本里带 "done" 就把 mission 标 done** —— 即使任务链里还有 `pending`/`running`/`blocked`；
完成收据与独立裁决在控制器里**根本没有被调用**（`isCompletionReceiptRequired` 只被透传，无人消费）。

## 2. 契约（冻结）

1. **始终生效**（不看开关）：`projectMissionCompletionGate` 要求任务链里**所有任务 `done`**；
   存在未完成任务 ⇒ 列出 `taskId(status)` 并阻断。
2. **严格模式**（`isCompletionReceiptRequired === true`，缺省 off）：
   - 每个 `done` 任务必须有**足够收据**（`evaluateCompletionReceipt`；缺省无读取端口 ⇒ 视为缺失）；
   - 必须存在**已接受的独立完成裁决**（`completionVerdictReader`；缺省 ⇒ 视为缺失）。
3. **失败方向**：门禁不放行 ⇒ mission 置 `blocked` + 流式输出原因，**绝不标 done**；
   不补默认收据、不伪造裁决。
4. **只读**：`projectMissionCompletionGate` 不启动/停止任务、不改状态；供回调与 UI 共用。
5. **取消不受影响**：`cancelled` 分支保持原行为（取消不需要完成证据）。

## 3. 生产调用链（源码位置）

```
SecondaryAgent.onReportToMain（"任务完成状态:" 分支）      packages/core/src/orchestration/main-controller.ts
├─ status = "done" → projectMissionCompletionGate
│  ├─ MissionManager.getMissionStatus（任务链全 done？）
│  ├─ evaluateCompletionReceipt（严格模式；completionReceiptReader）
│  └─ completionVerdictReader（严格模式；必须是已接受裁决）
├─ 不放行 ⇒ release + streamOutput + updateMissionStatus("blocked")
└─ 放行 ⇒ release + onMissionFinished + registerMissionArtifacts + 事件 + updateMissionStatus("done") + 报告索引
```

## 4. 未完成（如实）

- **没有收据/裁决的生产方**：仓库里没有任何地方写完成收据或完成裁决；
  打开严格开关后，**所有 done 都会被阻断**（fail-closed，这是刻意的，也是该开关默认关闭的原因）。
- **只接了 assist 路径**：`devolve`（次级独立运行 mission）的完成不经过该分支，**未受门禁约束**
  （需要接到 `MissionOrchestrator.finishMission`，属后续工作）。
- **没有 UI**：门禁拒绝原因只进流式输出与 mission 状态，没有结构化展示。
- **判决语义未与合并门禁统一**：`IndependentReviewGate` 是合并前置，本处是完成前置，
  两者对"接受"的定义尚未统一。
- **未验证**：没跑过"有 pending ⇒ blocked""严格模式缺收据 ⇒ blocked""有裁决且收据齐 ⇒ done"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。

## 7. 更新（R47，2026-10-29）：生产方已存在，"默认关闭"的理由已改变

本文写于 2026-10-28，当时结论是"**没有任何地方写完成收据或完成裁决**"，因此打开严格开关
会阻断所有 done（fail-closed），这是开关默认关闭的原因。**该前提已被 R6–R12 推翻**：

| 事实 | 现状 | 证据 |
|---|---|---|
| 收据生产方 | worker 成功分支构造收据，调度器 `success` 分支**先落盘再走门禁** | ADR-0095/0096 |
| 收据读取 | 严格模式 `completionReceiptReader` 读同一份存储 | ADR-0097 |
| 裁决生产方 | `IndependentReviewGate.recordVerdict` 校验通过后落盘 | ADR-0098/0100 |
| 裁决读取 | 逐任务对齐（缺任一任务裁决 ⇒ 不通过） | ADR-0099/0101 |
| devolve 路径 | 控制器把 `completionReceiptStore` 同时传给 assist 与 devolve | `main-controller.ts:3091` / `:3306` |

**仍然成立的部分**：
- **严格开关默认关闭**（`isCompletionReceiptRequired` 缺省 false）—— 但现在的理由是
  "**未运行验证**"，不再是"没有生产方"；
- 收据/裁决的写入、幂等、拒绝覆盖、逐任务对齐**全部未运行验证**；
- 没有收据或没有裁决时仍然 **fail-closed**（不伪造 done），这是刻意行为。

**结论**：本文 §3 的"打开后所有 done 都会被阻断"**已过期**；新结论是"打开后会按收据 + 逐任务裁决
判定，缺证据才阻断"，但仍**没有实测**。
