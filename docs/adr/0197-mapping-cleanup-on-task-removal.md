# ADR-0197 删除任务时清理映射（R139，2026-11-03）

- 状态：**已实现**（存储方法 + 图变更联动；单测）
- 来源：用户"继续"（R134 遗留：映射不随图变更清理）
- 相关：ADR-0182（映射）、ADR-0188（删除叶子）、ADR-0192（重算 V）

## 1. 问题

删除 pending 任务后，映射仍指向已消失的任务 id；下一次写回提案/重算会把该节点当作
"未知"处理，产生噪声（并可能误导"V 上升"）。

## 2. 设计

1. `MissionTaskSequenceMapStore.removeForMissionTask({missionIdentifier, missionTaskIdentifier})`：
   - 只删匹配 mission + missionTask 的映射；
   - **`"*"`（整 mission）保留**（删单个任务不代表整个 mission 失效）；
   - 原子写；返回删除条数。
2. 运行时在 `onMissionGraphChanged` 中，`changeKind === "remove"` 时先清理映射，再走
   "重算 V → 判断是否暂停"。

## 3. 验证

```
tests/core/mission-task-sequence-map.test.ts → 4/4
  删除 T-99 的映射后只剩 "*"；removedCount=1。
tests/core --maxWorkers=2 → 3653 tests 全通过（无 Errors）
typecheck / lint / build → 全绿
```

## 4. 未完成

- 清理是 fire-and-forget（失败忽略），不做重试/告警；
- 删除**已映射的序列节点**（反向：序列节点被删）没有对应清理入口；
- 没有联动测试"删除任务 ⇒ 映射清理 + V 重算"的完整链路（只有存储单测）；
- `"*"` 映射在整 mission 被删除/取消时也没有清理。
