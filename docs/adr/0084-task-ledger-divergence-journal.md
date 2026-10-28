# ADR-0084 两套记账的差异历史（清单第 ① 项收尾）

- 状态：部分采纳（记录已接；不修复、无 UI）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ① 项
- 相关：ADR-0078（记账对照）、ADR-0083（安全点注入）

## 1. 背景

ADR-0078 让"两套记账差在哪"**可查一次**；ADR-0083 让运行中插入在安全点真的生效。
但差异**没有历史**：只能当场看，事后无法回答"上次插入后两边是否漂移、漂了多少次"。

## 2. 契约（冻结）

1. **只记录、不修复**：journal 不写序列、不改任务链、不触发派发；任何"修复"都必须另走显式路径。
2. **记录时机**：`requestRuntimeTaskInsertion` 的两条出口（`inserted` / `deferred-to-sequence`）
   各记录一条快照，`trigger` 区分 `runtime-insert-injected` / `runtime-insert-deferred`。
3. **快照字段**：mission / 序列标识与 revision、两边任务数、
   `tasksOnlyInSequence`、`tasksOnlyInMission`、状态不一致数量、
   **`divergenceHash`**（差异内容哈希）、时间、trigger。
4. **去重**：与**上一条** `divergenceHash` 相同 ⇒ 不重复记录（同一漂移不刷屏）；
   但**不同差异不会被合并**（每条都留痕）。
5. **有界**：缺省最多 200 条，先进先出（不无界增长）。
6. **不阻断业务**：记录失败（读不到对照、写盘失败）**不影响插入结果**，也不改写任何记账。
7. **落盘**：`<state>/task-ledger-divergence/journal.json`（原子写 + 互斥 + 备份恢复）。

## 3. 生产调用链（源码位置）

```
MainController.requestRuntimeTaskInsertion
├─ inserted        → recordTaskLedgerDivergenceSnapshot(trigger="runtime-insert-injected")
└─ deferred        → recordTaskLedgerDivergenceSnapshot(trigger="runtime-insert-deferred")
   └─ inspectTaskLedgerAlignment（ADR-0078，只读）
      └─ buildTaskLedgerDivergenceEntry + TaskLedgerDivergenceJournal.append
          packages/core/src/orchestration/task-ledger-divergence-journal.ts
运行时装配
└─ application-runtime：构造 journal（state 目录）→ 控制器选项 + runtime 句柄
```

## 4. 未完成（如实）

- **不修复**：差异只留痕；没有"用序列覆盖 mission 链"或反向同步的任何路径。
- **没有 UI/CLI**：`readRecent` 只有程序化入口，用户看不到历史。
- **只有插入路径在记录**：恢复、任务组收口、手动检查等场景**不会**自动记一条。
- **哈希只用于去重**：相同哈希**不代表两边一致**（它是差异内容的哈希），
  不要把"没有新条目"读成"已经一致"。
- **未验证**：没有跑过"注入后记录一条""推迟后记录一条""连续相同差异被去重"
  "超过 200 条先进先出"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
