# STATUS_UPDATE：e2e01-vertical-rework「产物路径非空 ⇒ blocked」已查明（2026-11-17）

**性质**：调查结论 + 文档更正。本轮**未修改产品代码**（结论是"不需要回填 `resultLocation`"）。
共享台账 `docs/reports/TASKCARD_BACKLOG_2026-10-17.md` 未改动；本文件说明待合入位置。

## 1. 台账待更正的两处陈述

位置：`docs/reports/TASKCARD_BACKLOG_2026-10-17.md` 第 2044–2060 行（2026-11-10 第六轮巡检记录）。

| 原文 | 现状（已核实） |
|---|---|
| "送审前置检查在生产里永远读到『未登记产物路径』⇒ **独立验收必然走 rework，闭环不可达**" | **已过时**：送审产物取自**完成收据**，不是 `resultLocation`。见 `mission-orchestrator.ts:1488-1493`：`artifactPaths: [...outcome.completionReceipt.artifactPaths]`；`main-controller.ts:3141-3145` 也优先用收据产物，`resultLocation` 只作回退 |
| "下一步：查清『产物路径非空 ⇒ blocked』的具体判定点" | **已查明**：见第 2 节 |

## 2. 判定点（已定位）

`packages/core/src/orchestration/main-controller.ts:3221-3225`

```ts
/** 已产出（有 resultLocation）但尚未 done ⇒ 先对账，不盲目重跑。 */
if (task.resultLocation !== null && task.resultLocation !== "") {
  producedButUnacknowledgedTaskIdentifiers.push(task.id);
  continue;
}
```

随后在 3246-3249 把该集合转成阻塞原因：
`任务已产出但未回执，需先对账: …` ⇒ mission 判定为 `blocked`。

**语义**：`resultLocation` 在恢复对账里是"**已有副产物、尚未回执**"的信号；
把它当作"送审产物指针"回填，等于对恢复流程谎报"产出已确认"。

## 3. 结论

- 台账里那次"回填 `resultLocation` 导致返修任务变 blocked"**不是新缺陷**，而是**语义冲突**的必然结果；
- 正确做法**不是**回填 `resultLocation`，而是让送审产物走**完成收据**（现状已经如此）；
- 因此本断点**关闭**：无需改动产品代码，需要的是更正文档并加守卫防止有人再去回填。

## 4. 现状验证

| 项 | 结果 |
|---|---|
| `npx vitest run tests/core/integration/e2e01-vertical-rework.test.ts` | 1 passed（当前生产代码，未做任何回填） |
| 审查闭环 e2e | `tests/core/integration/align03-review-loop-e2e.test.ts` 通过（含"写工具产出后任务链出现 review:* 节点"） |
| 守卫 | 新增 `tests/architecture/crosscheck01-result-location-semantics.test.ts`，钉住两条事实 |

## 5. 未完成 / 不声称

- 未做"真实进程级"演练；
- 未改 `worker-agent` 的 `resultLocation` 恒为 null 的现状——**这是刻意的**：
  它是恢复对账信号，不是产物指针；若要填，必须先厘清对账语义。
