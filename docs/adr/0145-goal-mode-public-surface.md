# ADR-0145 目标模式的公开入口（R81，2026-10-31）

- 状态：已采纳（公开 SDK + CLI；真实 mission 已用新入口实跑）
- 来源：首次真实验收发现"目标模式无公开入口"（[GOAL02_REAL_MISSION_ACCEPTANCE_2026-10-31](../reports/GOAL02_REAL_MISSION_ACCEPTANCE_2026-10-31.md) §5）
- 相关：ADR-0116（控制面）、ADR-0138（提案/确认）、ADR-0139（完成耦合）、ADR-0140（组边界）

## 1. 背景

目标模式内核在 R71–R79 补齐后，公开 SDK 与 CLI **没有任何写入口**；`submitTask` 也不能
"带着目标创建 mission"。结果：门禁在启动时评估不到目标，整条"目标驱动"链路无法真实跑通。

## 2. 设计（冻结）

1. **创建时绑定**（关键）：
   - `MainControllerOptions.bindMissionGoalPort`（运行时实现：写绑定 + 刷新门禁缓存）；
   - `handleUserMessage(..., { goalIdentifier })`：在 `launch*Mission` **之前**绑定；
   - 未装配端口却给了目标 ⇒ 直接拒绝（不静默忽略）；
   - `PublicApplicationService.submitTask` 新增可选 `goalIdentifier`。
2. **公开 SDK 方法**（直接委托运行时，不复制规则）：
   `activateGoalMode` / `getGoalModeActivation` / `proposeGoalContract` / `confirmGoalContract` /
   `createGoalContract` / `bindMissionToGoal` / `unbindMissionFromGoal` / `describeGoalStatus` /
   `deactivateGoal` / `closeGoalExperiment` / `bindRequirementTaskMapping` / `invalidateGoalEvidence`。
3. **创建选项透传**：`isGoalModeEnforcementEnabled` / `isGoalCompletionRequired` /
   `missionToolCallBudget`（缺省全关）。
4. **CLI**：
   - `goal-mode propose --source <ref> [--file|stdin] [--ttl-seconds]`
   - `goal-mode confirm <proposal> --goal <id> --owner <user> --yes`（**没有 `--yes` 一律拒绝**）
   - `goal-mode bind <mission> --goal <id>`（事后绑定，明确提示不改变本次派发结论）
   - `goal-mode map --goal --requirement --tasks`
   - `run --goal <id> [--goal-enforce] [--goal-require-completion] [--goal-budget <n>]`
     —— 给出 `--goal` 时先以**用户显式请求**激活目标模式，再提交。

## 3. 调用链（源码位置）

```
cli run --goal            → executeRunCommand：activateGoalMode → submitTask({goalIdentifier})
  └─ facade.submitTask    → controller.handleUserMessage(..., {goalIdentifier})
     └─ bindMissionGoalPort（runtime：bindingStore.bind + refreshGoalGateCache）
        └─ launchAssistMission → observeGoalDispatchGate（此时已能看到目标）
cli goal-mode confirm     → facade.activateGoalMode + confirmGoalContract
cli goal-mode propose/map → facade.proposeGoalContract / bindRequirementTaskMapping
```

## 4. 真实运行证据（2026-10-31）

见 [acceptance 报告 §8](../reports/GOAL02_REAL_MISSION_ACCEPTANCE_2026-10-31.md)：
`goal-mode propose/confirm/status/map` 全部真实执行；`run --goal` 的 mission 被**创建时绑定**
（`mission-bindings.json` 三条绑定）；判定记录落盘（`isEnforced=false` 只观察）；
`--goal-require-completion` 时真实输出
`目标未完成，不标记完成: 要求 req-1 证据不足（unverified）。；V 仍为 1，不是 0。`

## 5. 未完成（如实）

- **`--goal-enforce` 的组边界停止未实跑**（需要"运行中目标被暂停"的场景，当前单任务 mission 难以触发）；
- **正向完成未达成**：`req-1` 需要 **accepted 独立裁决** 才能 `valid`，当前单任务流程没有产生裁决记录 ⇒ V 恒为 1；
- **提案仍由 CLI 用户输入 JSON**（模型工具尚未注册，模型不能自己在对话里提议）；
- **`goal-mode bind` 是事后补登记**，不改变本次派发结论（已提示）；
- **激活仍是进程内状态**：`run` 每次都要显式 `--goal`；
- **无自动化测试** 覆盖新 CLI/门面路径（仅真实手工运行）。

## 6. 验证状态

真实手工实跑：propose/confirm/status/map/bind-at-creation/判定落盘/K7 拒绝 均**已验证**；
`typecheck`/`lint`/`build` 绿；`tests/core --maxWorkers=2` 3584 全通过。
