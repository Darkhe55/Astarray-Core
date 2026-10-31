# ADR-0157 裁决后 V 重算（方案 B，2026-11-01）

- 状态：**已实现并真实跑通**（accepted 裁决 ⇒ V=0，来源独立验收）
- 来源：用户"跑"（②最后一块）
- 相关：ADR-0156（裁决演练）、ADR-0146（证据来源）、ADR-0137（映射）

## 1. 背景

V 只在**组结束时**计算，而 accepted 裁决只能在任务完成后记录：
单任务 mission 的组结束早于裁决写入 ⇒ `independent-acceptance` 要求永远停在 `unverified`。
方案 A（多组 mission）需要规划器产出多任务（当前 CLI 恒为 `legacy-single-node`），
因此实现**方案 B：裁决后按当前证据重算 V**。

## 2. 设计

新增 `recomputeGoalPotential({goalIdentifier, missionIdentifier})`（运行时 + SDK + CLI）：

- **只读**任务链/完成收据/完成裁决 + 已存映射，调用既有 `assessGoalRequirementsFromLocalState`
  与 `computeGoalPotential`（不复制规则）；
- 前置：契约与状态存在且 revision 一致，否则 `skipped`；
- 结果：写回 `requirementBases`、`lastPotentialValue`、`gateSnapshot.lastPotentialValue`，
  `documentRevision+1`；**不改**暂停/门禁/实验关闭等状态；
- `unreliable` 谓词 ⇒ `status: "unknown"`（不写伪值）。

CLI：`goal-mode recompute --goal <id> --mission <id>`。

## 3. 真实运行证据（2026-11-01 01:5x）

1. **真实 mission**：`mission-a21df78c`（goal-verdict，`req-1` 为 `independent-acceptance`）
   → `status: done`；此时 `goal-mode status` 为 **V=1**（无裁决）。
2. **记录 accepted 裁决**（演练脚本，三身份任命 + `merge-ready` + 非自报证据）：
   `state/completion-verdicts/mission-a21df78c/T-001.json` 落盘。
3. **重算**：

```
goal-mode recompute --goal goal-verdict --mission mission-a21df78c
→ {"status":"computed","potentialValue":0}

goal-mode status → lastPotentialValue: 0
状态文件 → requirementBases[0].evidence = {
  "kind": "valid",
  "evidenceKind": "independent-acceptance",
  "evidenceReference": "task-ledger:T-001"
}, remainingContribution: 0
```

即：**accepted 裁决把 V 从 1 推到 0，且证据来源如实标为独立验收**。

## 4. 未完成 / 限制

- **不是自动触发**：需要宿主/用户显式 `recompute`（未接"裁决落盘后自动重算"，那需要事件订阅）；
- **内存门禁未同步**：只更新持久状态与快照；若进程内有活动门禁，其内存 V 仍是旧值，
  直到下次 `hydrate`/组结束（真实验收是 mission 结束后重算，无活动门禁，故未受影响）；
- **多组 mission（方案 A）仍未验证**：CLI 没有任务分解提供者，恒为单节点。

## 5. 验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3591 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 真实链路：mission done → 裁决落盘 → 重算 V=0（独立验收来源）。
