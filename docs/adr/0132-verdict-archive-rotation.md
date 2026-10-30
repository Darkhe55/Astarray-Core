# ADR-0132 判定记录溢出归档 + 导出含归档（R63，2026-10-30）

- 状态：已采纳（归档已接；归档本身无上限）
- 来源：用户选择继续代码项 B（判定轮转）；[ADR-0120](0120-goal-verdict-journal.md)
- 相关：[ADR-0128](0128-verdict-export.md)（导出）、[ADR-0113](0113-deferred-insertion-drop-observability.md)（同类"截断可观察"）

## 1. 背景

`GoalDispatchVerdictJournal` 有界 200 条：超出后**直接丢最旧**，只留 `droppedRecordCount` 计数。
"某次阻断发生在什么时候"一旦被挤出窗口就**再也查不到**。

## 2. 变更（冻结）

1. 新增归档文件 `<state>/goal-mode/dispatch-verdicts-archive.jsonl`（**追加写**，每行一条）。
2. `record()` 溢出时：**先归档、再裁剪**；
   - 归档成功 ⇒ 活动文件裁剪到上限，**不计入 `droppedRecordCount`**；
   - **归档失败 ⇒ 不裁剪**（宁可活动文件超限，也不让记录消失），并如实计入 `droppedRecordCount`；
   - 返回 `{droppedRecordCount, archivedRecordCount}`。
3. `goal-mode verdicts --export <path> --include-archive`：导出时把归档行**放在前面**再拼活动记录；
   没有归档文件 ⇒ 视为空（不报错）。
4. 归档**无上限、无压缩、不轮转**（增长由外部治理；本窗口不做）。

## 3. 生产调用链（源码位置）

```
MainController.observeGoalDispatchGate → onGoalDispatchVerdict
└─ GoalDispatchVerdictJournal.record              goal-dispatch-verdict-journal.ts
   ├─ overflow ⇒ appendFile(dispatch-verdicts-archive.jsonl)
   └─ writeAtomicJson(dispatch-verdicts.json, 裁剪后)
CLI goal-mode verdicts --export X --include-archive
└─ readFile(archive.jsonl) + document.records → JSONL
```

## 4. 运行证据（本次真实执行）

```
npx vitest run tests/core/goal-dispatch-verdict-journal.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

覆盖：①溢出 1 条 ⇒ 归档 1 行、活动仍 2 条、`droppedRecordCount` 仍为 0、归档首行是被挤出的那条；
②连续写 5 条（上限 2）⇒ 活动为最后 2 条、归档 3 行且顺序正确。

另：`typecheck` 0、`eslint .` 0、`build` 成功。

## 5. 能说明 / 不能说明

**能**：溢出时旧记录**确实进入归档**、活动视图**确实有界**、归档顺序正确、`droppedRecordCount` 不误增。

**不能**：
- 不能说明"归档失败时不裁剪"这条分支（未构造失败场景）；
- 不能说明运行期 `onGoalDispatchVerdict` 真的调用了 `record`（集成路径未测）；
- **归档本身会无限增长**（无上限/压缩/清理）；
- `--include-archive` 的导出**未运行验证**。

## 6. 验证状态

- 存储行为（本测试覆盖部分）：**已运行通过**；
- 导出与集成接线：`implemented-unverified`。
