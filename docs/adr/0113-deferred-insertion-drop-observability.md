# ADR-0113 已消费历史的截断可观察（两套记账收口 R26）

- 状态：已采纳（计数 + 提示；保留策略不变）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R26
- 相关：ADR-0111（队列）、ADR-0112（消费）

## 1. 背景

R25 给 `consumed` 加了 200 条上限，**超出时静默丢弃最旧**：
"历史上曾经消费过什么"可能已经不完整，但界面与日志都看不出来。

## 2. 变更（冻结）

1. 队列文档新增 `droppedConsumedCount`（累计丢弃条数）与 `lastDroppedAtIso`（最后丢弃时间）；
   旧文件缺字段 ⇒ 读作 `0` / `null`（向后兼容，不伪造历史）。
2. `markConsumed` 返回 `{didConsume, droppedCount}`；丢弃发生时累加计数并记录时间。
3. 控制器在 `droppedCount > 0` 时 `streamOutput` 告知"已丢弃最旧 N 条，可用
   `--deferred-insertions` 查看累计丢弃数"。
4. CLI `--deferred-insertions` 输出 `droppedConsumedCount` 与 `lastDroppedAtIso`
   （文本模式写"已消费历史被截断: N 条（最后丢弃于 …）/（未截断）"）。
5. **不改变保留策略**：仍然是 200 条上限、仍然丢最旧。

## 3. 生产调用链（源码位置）

```
DeferredInsertionQueueStore.markConsumed            packages/core/src/orchestration/deferred-insertion-queue.ts
├─ 计算 droppedCount = max(0, nextConsumed.length - 200)
├─ droppedConsumedCount += droppedCount；lastDroppedAtIso
└─ 返回 {didConsume, droppedCount}
MainController.consumeDeferredInsertions            main-controller.ts
└─ droppedCount > 0 ⇒ streamOutput 提示
CLI task-ledger status --deferred-insertions        packages/tui/src/cli/task-ledger-command.ts
└─ read() ⇒ droppedConsumedCount / lastDroppedAtIso
```

## 4. 未完成（如实）

- **只有累计计数**：不知道"哪几条"被丢弃（没有丢弃清单，也无从恢复）。
- **没有指标/告警**：只进 `streamOutput` 与 CLI，不接观测系统。
- **上限仍写死 200（可构造时覆盖）**：没有用户配置入口。
- **未运行验证**：没跑过"未超上限 ⇒ 0""超上限 ⇒ 计数与时间正确""旧文件缺字段 ⇒ 读作 0"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
