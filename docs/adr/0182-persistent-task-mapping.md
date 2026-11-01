# ADR-0182 持久任务映射与多节点写回（R123，2026-11-01）

- 状态：**已实现并跑通**（映射存储 + 提案按映射 + CLI 登记 + 双节点应用）
- 来源：用户"1"（补持久 id 映射表，让多节点序列可写回）
- 相关：ADR-0180/0181（id 不对齐、整 mission 对齐）、ADR-0052（结构性缺口）

## 1. 新增

1. `MissionTaskSequenceMapStore`（`<state>/task-ledger/mission-task-maps.json`）：
   - 记录 `missionIdentifier / sequenceIdentifier / owner / missionTaskIdentifier / sequenceTaskIdentifier / mappedAtIso`；
   - 同 mission+missionTask 重复绑定到不同节点 ⇒ 拒绝（`journal-corrupted`，不静默改绑）；
   - 同一对重复绑定 ⇒ 幂等；原子写。
2. 提案按映射对齐：`TaskLedgerBridge` 增加可选 `taskMappings` 端口；有映射时**逐对比较**
   （mission 任务 done + 节点未 done ⇒ `mark-sequence-done`，目标为**序列节点 id**），
   不再走整 mission / 逐 id 推断。
3. CLI `task-ledger bind-task-map --mission … --mission-task T-01 --sequence-task node-a`：
   校验 mission 任务与序列节点都真实存在再登记。

## 2. 真实存储端到端（双节点夹具 `mission-wb2`/`sequence-wb2`）

```
bind-task-map T-01→node-a / T-02→node-b
status --propose-writeback → 2 条 mark-sequence-done（node-a、node-b），revision 2
apply-writeback --expected-revision 2
→ applied ["node-a","node-b"]，sequenceRevisionAfter=6
序列：node-a done、node-b done
```

## 3. 验证

```
tests/core/mission-task-sequence-map.test.ts → 2/2（幂等/改绑拒绝、按映射生成提案）
tests/core --maxWorkers=2 → 471 files / 3625 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- **映射需人工登记**：运行时发布任务时**不会自动写映射**（自动登记需要发布端改造）；
- 映射是单向的（mission→sequence），没有反向查询 CLI；
- 映射过期（节点被删）只以 notes 提示，不自动清理；
- 多节点应用**非原子**：中途失败会留下部分已 done（与 ADR-0179 一致）；
- `bind-task-map` 无自动化 CLI 测试（仅有手动 E2E 与存储/提案单测）。
