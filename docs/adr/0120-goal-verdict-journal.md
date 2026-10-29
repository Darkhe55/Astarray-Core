# ADR-0120 目标门禁判定落盘（GOAL-02 R35）

- 状态：已采纳（记录已接；不改判定行为）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R35
- 相关：ADR-0114（提案）、ADR-0104（同类环形记录）

## 1. 背景

`observeGoalDispatchGate` 把每次判定交给 `onGoalDispatchVerdict` 回调；宿主没订阅就**什么都没留下**。
事后无法回答"这次派发为什么被放行 / 被拦"，也无法核对"当时强制模式开没开"。

## 2. 设计（冻结）

1. 新增 `GoalDispatchVerdictJournal`：`<state>/goal-mode/dispatch-verdicts.json`；
   **有界 200 条**（可构造时覆盖），超出丢最旧并累计 `droppedRecordCount` + `totalRecordedCount`。
2. 记录字段：mission / project / 契约 revision / `isAllowed` / `reasonCode` / `detail` /
   `evidenceGaps` / **`isEnforced`** / `observedAtIso`；**不含正文**。
3. 运行时**总是**装配 `onGoalDispatchVerdict`：先 `void journal.record(...)`（失败被吞掉，
   不成为派发单点故障），再调用宿主自己的回调（若提供）。
4. CLI：`goal-mode verdicts [--recent N] [--json]` 只读列出最近记录，
   显示累计/丢弃数，并注明 `isEnforced=false` 表示仅观察未阻断。

## 3. 生产调用链（源码位置）

```
MainController.observeGoalDispatchGate            main-controller.ts
└─ onGoalDispatchVerdict(record)                  ← runtime 总是装配
   ├─ GoalDispatchVerdictJournal.record           goal-dispatch-verdict-journal.ts
   │  └─ <state>/goal-mode/dispatch-verdicts.json（有界 200；原子写 + 备份）
   └─ options.onGoalDispatchVerdict?.(record)（宿主回调，可选）
CLI：goal-mode verdicts → readRecent(N)
```

## 4. 未完成（如实）

- **不改判定行为**：仍只观察（`isEnforced` 由 `isGoalModeEnforcementEnabled` 决定，缺省 false）。
- **写入是 fire-and-forget**：`void` + 吞错 ⇒ 写失败**不会被任何人看到**（这是刻意的"诊断不得阻断"，
  但也意味着没有告警）。
- **每次判定都写文件**：高频派发下 IO 成本未测；没有批量/异步刷盘。
- **无导出/轮转**：200 条之外只剩计数；没有按时间归档。
- **未运行验证**：没跑过"记录一条 / 超 200 丢最旧 / 落盘失败不影响判定"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
