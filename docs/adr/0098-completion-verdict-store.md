# ADR-0098 独立完成裁决的本地存储（完成门禁生产方 R9）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R9
- 相关：ADR-0079（完成门禁）、ADR-0097（收据读取）、`IndependentReviewGate`

## 1. 背景

严格完成门禁需要"收据 + 独立裁决"两类证据。收据已可写可读（R6–R8），
但**裁决只有读取端口、没有存储也没有写入方** ⇒ `completionVerdictReader` 永远拿不到东西。

## 2. 设计（冻结）

1. **位置**：`<state>/completion-verdicts/<mission>/<task>.json`（路径清洗、原子写、备份恢复）。
2. **必填**：mission、task、`verdict ∈ {accepted, rejected}`、裁决者**具体个体标识**
   （不接受匿名/角色名）、时间；`rejected` **必须**带理由。
3. **不可改写**：同 mission/task 已有裁决 —— 内容相同 ⇒ 幂等（`didWrite:false`）；
   不同 ⇒ `journal-corrupted` **拒绝覆盖**（裁决是证据，不允许事后改写）。
4. **损坏 ⇒ null**：读回损坏/非法文件不伪造裁决。
5. **不做独立性判断**：本模块只记录；"裁决者是否独立"仍由 `IndependentReviewGate`
   （任命/注册目录/自审拒绝）负责 —— 两层职责不混。

## 3. 生产调用链（源码位置）

```
（R10 将由 completionVerdictReader 读取；写入方由裁决流程调用）
CompletionVerdictStore.save(record)          packages/core/src/orchestration/completion-verdict-store.ts
├─ 必填/理由/时间校验（非法 ⇒ invalid-task-chain）
├─ read 既有裁决（同内容幂等；不同 ⇒ journal-corrupted）
└─ writeAtomicJson(<state>/completion-verdicts/<mission>/<task>.json)
```

当前**无生产调用方**：本模块只提供存储能力。

## 4. 未完成（如实）

- **没有写入方**：谁来写裁决（哪条流程、哪个身份）尚未接；`IndependentReviewGate` 的
  `recordVerdict` 也没有写本存储。
- **没有读取方**：`completionVerdictReader` 未接（R10）。
- **不校验裁决者独立性**（有意留给门禁层）。
- **未运行验证**：没跑过"首次写入""同内容幂等""不同内容拒绝覆盖""rejected 无理由拒绝"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
