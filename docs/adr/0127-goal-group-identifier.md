# ADR-0127 组标识带运行时间前缀（GOAL-02 R52）

- 状态：已采纳（只改标识生成，不改组语义）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R52、ADR-0119
- 相关：ADR-0112（组边界近似）、ADR-0126（组性质）

## 1. 背景

R34 的组标识是 `task-group-<n>`，`n` 在**每个进程内**递增：
重启后从 1 重新开始，历史状态里的旧组与本次运行的组**同名**，无法区分"这是哪一次运行的组"。
组标识会被写进 `PersistedGoalModeState.currentTaskGroupIdentifier` 与
`deferred-insertions.json.consumedByGroupIdentifier`，同名会让事后对账失去依据。

## 2. 变更（冻结）

组开始时生成：

```
goal-group-<UTC 时间戳 14 位>-<n>
  例：goal-group-20261029T203000-1
```

- 时间戳取**组开始时刻**的 ISO 字符串，去掉 `- : T Z .` 后取前 14 位（`YYYYMMDDhhmmss`）；
- 同一进程内 `n` 仍递增；跨进程因时间戳不同而可区分、可按时间排序；
- `startedAtIso` 与标识同源（不再另取一次 `new Date()`，避免两者跨秒不一致）。

**不改**：开始/结束的触发条件、组性质（R51）、V 计算（R38）、状态字段结构。

## 3. 生产调用链（源码位置）

```
MissionOrchestrator.runLoop                        mission-orchestrator.ts
└─ 有 start-task ⇒ taskGroupStartedAtIso = now
   ├─ taskGroupRunTag = ISO 去分隔符取 14 位
   ├─ taskGroupIdentifier = `goal-group-${runTag}-${n}`
   └─ goalTaskGroupBeginPort({taskGroupIdentifier, startedAtIso: taskGroupStartedAtIso})
      └─ state.currentTaskGroupIdentifier = identifier（持久化）
```

## 4. 未完成（如实）

- **不是全局唯一**：同一秒内重启且计数器相同理论上可撞名（实际需同一秒重新进入同一组，
  概率极低但**没有强保证**；没有 UUID/持久序列）。
- **不含 mission 标识**：多 mission 并发时依赖时间戳区分，仍未绑定 mission。
- **未运行验证**：没跑过"重启后标识不同""startedAtIso 与标识一致"任何一条。
- 旧状态里既有的 `task-group-<n>` 标识**不迁移**（只影响新组）。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
