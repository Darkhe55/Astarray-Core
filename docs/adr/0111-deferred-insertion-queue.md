# ADR-0111 推迟插入的显式队列（两套记账收口 R24）

- 状态：已采纳（入队 + 只读视图；**尚无消费方**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R24
- 相关：ADR-0110（单任务预检）、`task-ledger-divergence-journal`

## 1. 背景

运行中插入在非安全点走 `deferred-to-sequence`：任务进了权威序列，但"下一组要消费它"
只存在于**返回原因文本**里。进程重启后没有任何可消费清单，等于"推迟"只靠记忆。

## 2. 设计（冻结）

1. 存储：`<state>/task-ledger/deferred-insertions.json`，分 `pending` / `consumed`；
2. 入队：`deferred-to-sequence` 路径在写差异快照之后入队（`insertRequestIdentifier` 幂等；
   同请求不同任务/序列 ⇒ `journal-corrupted`）；**入队失败不阻断插入**，`streamOutput` 告知；
3. 消费：`markConsumed({insertRequestIdentifier, consumedAtIso, consumedByGroupIdentifier})`
   只把条目从 `pending` 移到 `consumed`；**本检查点不接任何消费方**（安全点判定属下一轮）；
4. 只读视图：`task-ledger status --deferred-insertions [--mission X]`，空队列输出
   `no-pending-insertions`，并写明"消费尚未接"；
5. 原子写 + 备份恢复；损坏读回空队列（宁可"没有待办"也不伪造）。

## 3. 生产调用链（源码位置）

```
MainController（非安全点插入）
├─ publishOrInsertTask（既有，任务进序列）
├─ recordTaskLedgerDivergenceSnapshot（既有）
└─ DeferredInsertionQueueStore.enqueue        packages/core/src/orchestration/deferred-insertion-queue.ts
   └─ <state>/task-ledger/deferred-insertions.json
CLI：task-ledger status --deferred-insertions → listPending
```

## 4. 未完成（如实）

- **没有消费方**：`markConsumed` 无生产调用者 ⇒ 队列会一直增长（可能有重复请求，靠请求标识幂等）。
- **不判定安全点**：消费时机仍需在编排层实现（组边界）。
- **队列不驱动派发**：即使消费，也不会让任务进入运行中图（那是 DagScheduler 的缺口）。
- **无清理/上限**：`consumed` 无上限；长期会变大。
- **未运行验证**：没跑过"入队幂等 / 同请求不同任务拒绝 / 标记消费 / 空队列视图"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
