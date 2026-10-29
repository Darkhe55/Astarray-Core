# ADR-0109 `task-ledger status` 一条命令对账 + 索引只读视图（R22）

- 状态：已采纳（CLI；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R22
- 相关：ADR-0108（mission↔序列 索引）、ADR-0085（`task-ledger status`）

## 1. 背景

R21 让 CLI 能从索引补全 sequence/owner，但输出没有区分两种"没结果"：
- **没给 mission**（用法问题）；
- **给了 mission 但索引里没有绑定**（索引问题，可能是从未发布、也可能是写入失败）。

两者用同一状态与退出码，排障时分不清。另外没有"看一眼索引里有什么"的入口。

## 2. 变更（冻结）

1. `--list-bindings`：只读列出全部 `mission → sequence / owner / boundAtIso`；
   空索引输出 `no-bindings` 并说明"缺失不等于两边不一致"。
2. `--mission X` 时自动补全 sequence/owner（R21 已做），并把缺结果分成两种状态：
   - `index-missing` ⇒ 退出码 `USAGE_ERROR(2)`，提示显式给 `--sequence/--owner`
     或用 `--list-bindings` 核对；
   - `missing-inputs`（没给 mission）⇒ 退出码 `SUCCESS(0)`，仍打印差异历史。
3. **不猜测**：两种状态都不会按任务名/路径推断映射。

## 3. 生产调用链（源码位置）

```
packages/tui/src/cli.tsx  task-ledger status --mission/--sequence/--owner/--list-bindings
└─ executeTaskLedgerStatusCommand          packages/tui/src/cli/task-ledger-command.ts
   ├─ isListBindings ⇒ MissionSequenceBindingStore.list()
   ├─ 缺 sequence/owner ⇒ MissionSequenceBindingStore.readForMission(mission)
   ├─ 缺结果 ⇒ index-missing | missing-inputs（不同退出码）
   └─ 齐备 ⇒ TaskLedgerBridge.inspectAlignment（只读）
```

## 4. 未完成（如实）

- **没有绑定/解绑命令**：索引只能由运行期写入，或人工编辑文件。
- **退出码是新增语义**：脚本若把 `task-ledger status` 的 2 当作失败需注意（此前缺失一律 0）。
- **未加 `--json` 之外的机器可读版本化**：`status` 字段值属事实约定，未版本化。
- **未运行验证**：没跑过"索引命中 ⇒ 自动对账""索引缺失 ⇒ 2""无 mission ⇒ 0 且打印历史"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
