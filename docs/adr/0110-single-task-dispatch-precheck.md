# ADR-0110 单任务派发的只读预检（两套记账收口 R23）

- 状态：已采纳（只读预检；**不派发**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R23
- 相关：ADR-0052（结构性缺口）、ADR-0109（CLI）

## 1. 背景

`TaskLedgerBridge` 早已能"显式拒绝"按 taskId 派发（`refused-unsupported`），但**只能整体对照**：
调用方若想知道"这个任务到底缺什么才能单独派发"，只能自己读两边再推断。

## 2. 设计（冻结）

1. `TaskLedgerBridge.inspectSingleTaskDispatchPrecheck`：**只读**给出
   `isDispatchable` + `blockedReasons` + 两侧状态 + `capabilities`。
2. 判定口径（**全部是"缺一不可"**，任一不满足即 blocked）：
   - 任务在权威序列中存在；
   - 任务在 mission 任务链中存在；
   - 两侧状态一致（不一致 ⇒ 先对账）；
   - 序列侧 `readyTaskIds` 包含该任务；
   - mission 侧状态为 `pending`。
3. **预检通过 ≠ 可派发**：返回里固定 `canDispatchTaskByTaskIdentifier: false` 与说明
   （编排层仍无按 taskId 的领取/派发 API）。
4. CLI：`task-ledger status --mission X --task Y`（缺 sequence/owner 时先用 R21 索引补全），
   输出 `dispatch-precheck-passed` / `dispatch-precheck-blocked`，**退出码 0**（报告不是错误）；
   只有"取快照失败/mission 不存在"才 `USAGE_ERROR`。

## 3. 生产调用链（源码位置）

```
cli.tsx task-ledger status --mission --task
└─ executeTaskLedgerStatusCommand                     packages/tui/src/cli/task-ledger-command.ts
   ├─ TaskLedgerBridge（sequenceLedger + missionTaskChain）
   └─ inspectSingleTaskDispatchPrecheck              packages/core/src/orchestration/task-ledger-bridge.ts
      ├─ TaskSequenceStatusController.getSnapshot
      └─ MissionManager.getMissionStatus
```

## 4. 未完成（如实）

- **没有真正派发**：预检只表达"缺什么"，`requestDispatchByTaskIdentifier` 仍返回拒绝。
- **不检查权限/租约/预算/目标门禁**：只就两套记账判定；这些在派发层。
- **依赖只借序列 ready 集合**：不展开具体依赖链（`blockedReasons` 不列哪个前置未完成）。
- **退出码 0 的取舍**：脚本需读 JSON `status` 区分通过/阻塞。
- **未运行验证**：没跑过"通过 / 序列缺任务 / 状态不一致 / 未 ready / mission 非 pending"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
