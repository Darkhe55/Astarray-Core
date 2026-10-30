# ADR-0134 归档治理：容量轮转 + 保留份数（R65，2026-10-30）

- 状态：已采纳（管理已接；仍非无限保留）
- 来源：用户选择 B2；[ADR-0132](0132-verdict-archive-rotation.md)（溢出归档）
- 相关：[ADR-0120](0120-goal-verdict-journal.md)（有界 200）

## 1. 背景

R63 让溢出记录进入 `dispatch-verdicts-archive.jsonl`，但**归档本身无上限**：
长期运行会持续增长，最终仍会撑爆磁盘或让导出变得不可用。

## 2. 设计（冻结）

`GoalDispatchVerdictJournal` 新增两个选项：

| 选项 | 缺省 | 行为 |
|---|---|---|
| `maximumArchiveLines` | **5000** | 当前归档超过该行数 ⇒ **轮转** |
| `archiveRetentionCount` | **2** | 轮转文件只保留最近 N 份，更旧的**删除** |

轮转规则：
1. 追加前先读当前归档行数；`当前行数 + 本次行数 ≤ 上限` ⇒ 直接追加；
2. 超限 ⇒ 把当前归档重命名为 `dispatch-verdicts-archive-<UTC14>-<n>.jsonl`
   （`n` 递增避免同秒重名），再创建一个新的空归档继续写；
3. 轮转后按**文件名排序**（时间戳+序号）保留最近 `archiveRetentionCount` 份，其余 `unlink`；
4. **任何一步失败都不阻断写入**（最坏是归档变大），失败不抛错。

## 3. 调用链（源码位置）

```
journal.record → rotateArchiveIfNeeded(incomingLines)     goal-dispatch-verdict-journal.ts
├─ countArchiveLines()（读 dispatch-verdicts-archive.jsonl）
├─ 超限 ⇒ rename → dispatch-verdicts-archive-<UTC14>-<n>.jsonl
├─ 清理：只保留最近 archiveRetentionCount 份
└─ appendFile(新归档)
```

## 4. 运行证据（真实）

```
npx vitest run tests/core/goal-dispatch-verdict-archive-governance.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

覆盖：
1. `maximumArchiveLines=2`、上限内轮转 ⇒ **出现轮转文件**，且"活动归档 + 全部轮转"行数合计 = 5（**不丢行**），
   `droppedRecordCount` 仍为 0；
2. `maximumArchiveLines=1`、`archiveRetentionCount=1` ⇒ 轮转文件数量 **≤ 1**（旧份被删）。

## 5. 未完成（如实）

- **仍会丢历史**：保留窗口外的轮转文件被**真正删除**（这是刻意的容量治理，不是无限保留）；
- **删除不可恢复、无审计**：没有"删了哪些文件"的记录；
- **单实例假设**：轮转/清理未加跨进程文件锁（多进程同时写会竞争）；
- **归档失败分支未测**；
- **`--include-archive` 只读当前归档**，**不读轮转文件**（导出会漏掉更早的历史）。

## 6. 验证状态

容量轮转与保留份数（本测试覆盖部分）：**已运行通过**；
删除审计、多进程竞争、失败分支、导出含轮转：`implemented-unverified`。
