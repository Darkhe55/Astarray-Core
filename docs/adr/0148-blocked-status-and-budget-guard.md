# ADR-0148 阻断状态如实上报与执行前预算守卫（R84，2026-10-31）

- 状态：已采纳（真实复跑验证；一处回归已修正）
- 来源：用户"修复"（R83 报告 §4 的两条不一致）
- 相关：ADR-0147（K10 验收）、ADR-0140（组边界）、ADR-0142（预算取更严）

## 1. 修复内容

### 1.1 启动被门禁阻断不再误报 `running`

`launchAssistMission` / `launchDevolveMission` 在门禁拒绝时：先置 mission `blocked`（保留记录），
然后**抛出** `invalid-task-chain`（带 `[目标门禁]` 原因）。调用方拿到明确失败，
而不是一个"看起来还在跑"的 mission。

**为什么不直接改状态映射**：先尝试把 `summary.status === "blocked"` 映射为 `blocked`，
结果 G5 早停续跑用例**稳定失败**——早停续跑期间 mission 会**短暂**处于 blocked，随后继续并完成；
提前收口就是错的。故该方法已回退，并在代码注释里写明原因。

### 1.2 工具调用预算：执行前守卫（不再先执行后记账）

- 门禁新增 `getEffectiveMaximumToolCalls()`（目标上限与任务预算取更严）；
- 控制器新增 `goalToolCallBudgetForMission` 端口 + **进程内计数**，
  在 `execute` **之前**检查：达到上限 ⇒ 抛 `tool-budget-exhausted`（**新错误码**，
  与权限拒绝分开，避免误触发 K4 不变量）；
- 运行时用 `GoalGateCache.resolve(...).getEffectiveMaximumToolCalls()` 提供上限（未绑定 ⇒ null）。

## 2. 真实复跑

### 2.1 启动阻断（暂停目标 + `--goal-enforce`）

```
run … --goal goal-acceptance-1 --goal-enforce
→ {"missionId":"mission-84d32982","status":"blocked","permissionAsk":"requires-human-resubmission"}
→ exit 1（blocked 非零，符合"未执行"）
```

修复前同一场景报 `status: "running"`。

### 2.2 预算执行前拒绝（`goal-k10b`，上限 1）

```
astarray: [需要用户] 任务 T-001 失败：目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 createProjectFile。
→ hello9.md 未创建
```

修复前第二次工具调用**仍会执行**（收据事后统计到 `2/1` 才暂停）。

## 3. 回归与验证

- **G5 早停续跑**：映射回退后 2/2 通过；
- 全量：`tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**（一次瞬时的
  `e2e01-provider-write-probe` 失败，单跑通过，判为负载抖动）；
- `typecheck` / `lint` / `build` 绿。

## 4. 仍未解决（如实）

1. **预算耗尽的终态语义**：任务因预算被拒 ⇒ 任务失败 ⇒ mission 显示 `cancelled`（而非 `blocked`），
   目标也不会自动暂停（`consumedToolCalls` 仍为 0，因为失败组不写收据计数）。这是**下一步要修的**；
2. **短暂 blocked 仍是外部可见状态**：轮询方可能看到 blocked→done；目前只保证"不提前收口"；
3. `permissionAsk: requires-human-resubmission` 在无权限询问时也会出现（映射遗留）；
4. 组边界停止的输出状态仍为 `cancelled`。

## 5. 验证状态

两条修复：**真实复跑已验证**；G5 回归：**已修复并通过**；全量：3588 通过。
