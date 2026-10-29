# ADR-0114 写回提案：只读生成，不执行（两套记账收口 R27）

- 状态：已采纳（只生成提案；**不写回**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R27
- 相关：ADR-0078（差异对照）、ADR-0110（单任务预检）、ADR-0052（缺口）

## 1. 背景

两套记账差异可被"看见"（对照报告、差异快照、queue），但**没有可审阅的中间产物**：
真要写回时，改哪条、依据是什么、风险是什么，全靠现场判断。

## 2. 设计（冻结）

`TaskLedgerBridge.buildWriteBackProposal`：基于对齐报告 + 两套快照，逐任务给出：

| `proposedAction` | 触发条件 | 说明 |
|---|---|---|
| `mark-sequence-done` | mission=done 且序列未 done | 最小改动，但可能让下游 ready 失真 |
| `needs-human-review` | 其它状态不一致（含 mission=pending、序列=done） | 不单向推导，交人决定 |
| `missing-in-sequence` | 只在 mission 链 | 写回需在序列建任务（**无此能力**） |
| `missing-in-mission` | 只在权威序列 | 补链或移除，方向相反，必须人定 |
| （无条目） | 两侧状态一致 | 不产出 no-op 噪声 |

固定约束：
- 每条 `requiresHumanApproval: true`；
- 整体 `isExecutable: false`；
- `notes` 说明"只读生成 / 应用前需重新生成（revision 可能已变）"；
- **不写任何文件、不改任何状态**。

CLI：`task-ledger status --mission X --propose-writeback`（缺 sequence/owner 用 R21 索引补全）；
无条目 ⇒ `no-writeback-needed`。

## 3. 生产调用链（源码位置）

```
cli.tsx task-ledger status --propose-writeback
└─ executeTaskLedgerStatusCommand                   packages/tui/src/cli/task-ledger-command.ts
   └─ TaskLedgerBridge.buildWriteBackProposal       packages/core/src/orchestration/task-ledger-bridge.ts
      ├─ inspectAlignment（既有差异对照）
      ├─ TaskSequenceStatusController.getSnapshot
      └─ MissionManager.getMissionStatus
```

## 4. 未完成（如实）

- **没有执行端**：提案不可应用；写回入口（带审批/审计）尚未实现。
- **提案不含 revision 校验防护**：应用时需自行比对 `sequenceRevision`。
- **`mark-sequence-done` 不检查下游依赖**：风险只写在文本里，没有自动阻断。
- **未运行验证**：没跑过四种 `proposedAction` 任一分支，也没跑过空提案。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
