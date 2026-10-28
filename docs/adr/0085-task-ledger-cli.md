# ADR-0085 只读对账 CLI：`task-ledger status`（清单第 ① 项出口）

- 状态：部分采纳（命令已注册；未在真实状态目录运行过）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ① 项
- 相关：ADR-0078（对照）、ADR-0084（差异历史）

## 1. 背景

ADR-0078 让差异**可查**、ADR-0084 让差异**有历史**，但两者都只有程序化入口：
用户在 CLI 里看不到"两套记账当前是否一致"。本检查点补一个**只读查询命令**，
让接线对用户可见 —— 不新增任何写路径。

## 2. 契约（冻结）

1. **只读**：命令不写任务链、不写序列、不派发、不调模型、不写任何文件
   （journal 也只读）。
2. **输入显式**：`--mission` / `--sequence` / `--owner` 三项齐备才做对照；
   **不猜测** mission 与序列的映射关系（仓库里没有该索引）。
3. **缺输入如实降级**：只展示最近 N 条差异历史，并打印 `missing-inputs` 与原因。
4. **输出两种形态**：默认人类可读；`--json` 给机器可读
   （`status: consistent | divergent | missing-inputs | failed`）。
5. **失败不粉饰**：对照失败 ⇒ `status:"failed"` + 原因，退出码 `USAGE_ERROR`；
   不输出伪造的空对照。
6. **实现边界**：只复用公开 core 的存储与 `TaskLedgerBridge`；
   **不放 UI 实现**（公开仓 CLI 只放控制面查询）。

## 3. 生产调用链（源码位置）

```
packages/tui/src/cli.tsx                 注册 task-ledger status
└─ packages/tui/src/cli/task-ledger-command.ts
   ├─ TaskLedgerDivergenceJournal.readRecent（历史，只读）
   ├─ TaskStore + MissionManager（mission 任务链）
   ├─ AgentTaskSequenceStore + TaskSequenceStatusController（权威序列，viewer=user）
   └─ TaskLedgerBridge.inspectAlignment（ADR-0078）
```

## 4. 未完成（如实）

- **没有在真实状态目录运行过**：本窗口不执行运行验证；命令的行为只有静态代码路径。
- **没有命令级测试**：参数解析、缺输入、JSON 形态都未跑。
- **没有 mission↔序列 的持久索引**：因此必须手填三个参数；这属于 ALIGN-04-01
  关系索引的扩展，**没有做**。
- **差异历史只能看最近 N 条**：没有按 mission 过滤（journal 是全局的）。
- **不修复**：命令只读；不一致仍然只能人工处理。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、**未执行该命令**。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
