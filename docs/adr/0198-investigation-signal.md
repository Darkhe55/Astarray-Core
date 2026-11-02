# ADR-0198 调查组（investigation）的本地信号（R141，2026-11-03）

- 状态：**已实现并经产品确认**（2026-11-03：全只读定义 + 返工优先）
- 来源：用户"2"（B3 需要先定义判定信号）；**2026-11-03 用户确认定义与优先级**
- 相关：ADR-0130（组性质默认策略）、ADR-0162（停滞检查）

## 1. 定义（已确认）

> 一个组是 `investigation`，当且仅当它**启动的全部任务**都声明了非空工具列表，
> 且这些工具在权限能力目录里**只映射到只读能力**（`*.read`、`git.read`、`backup.list`、`task.read`）。

保守取向：

- 任务没声明工具 ⇒ 不算（无法判断）；
- 任一工具未映射（目录里没有）⇒ 不算；
- 任一工具含写能力 ⇒ 不算；
- 混合读写 ⇒ 不算（不把写操作伪装成调查）。

优先级（`resolveGoalTaskGroupKind`，已确认"返工优先"）：

```
宿主 provider > rework（返工事实）> investigation（全部只读）> normal
```

## 2. 实现

- `goal-investigation-signal.ts`：`isReadOnlyToolName`（基于 `PermissionCapabilityCatalog` 默认映射）、
  `isInvestigationTaskGroup`；
- `DagScheduler.getTaskToolNames(taskIds)`：只读读取任务的工具声明；
- 编排器在组开始时计算 `investigationTaskIdentifiers` 并传给解析器；
- 解析器新增可选输入；空组仍 `normal`。

## 3. 语义影响（必须知道）

门禁的停滞检查**只统计 `normal` 组**（ADR-0162）。因此：

- 全只读的组现在会**暂停"连续未降"计数**（不计入检查）；
- 若一个 mission 长期只有只读组，停滞暂停会更晚触发（这是该语义的代价）；
- 写组、混合组不受影响。

## 4. 验证

```
tests/core/goal-task-group-kind.test.ts → 10/10
  全只读 ⇒ investigation；部分只读 ⇒ normal；返工优先 ⇒ rework；
  只读工具判定（readFile/searchProjectText 真，createProjectFile/未知 假）。
tests/core --maxWorkers=2 → 3657 tests 全通过（首轮负载下多文件超时，单跑均过，重跑 exit 0）
typecheck / lint / build → 全绿
```

## 5. 未完成

- 只在"组开始时"按声明工具判定，不检查实际调用（声明只读、实际写工具的情形由权限层拦截）；
- 未做真实 mission 的组性质演练（需要全部只读任务的 mission）；
- 只读 `PermissionCapabilityCatalog` 的**默认映射**；自定义/新增工具的映射不在其内 ⇒ 视为非只读。

## 6. 产品确认记录（2026-11-03）

用户确认：

1. **定义**：全只读组 = `investigation`（"1A"）；
2. **优先级**：`rework` 优先于 `investigation`（"2 保持"）；
3. **停滞豁免**：沿用任务卡 GOAL-02 检查点 02 的要求（调查/验证/返工可暂时不降 V），
   即只读调查组不计入停滞检查（"3A"）。

本 ADR 状态由"启发式、未确认"改为"已确认"；实现未改动。