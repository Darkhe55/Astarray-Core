# ADR-0189 运行中改图：安全点重连依赖（R131，2026-11-02）

- 状态：**已实现**（只改单个 pending/blocked 节点的依赖边；安全点内）
- 来源：用户"1"（ADR-0052 核心：改依赖）
- 相关：ADR-0188（注入/删叶子）、ADR-0187（改内容）、ADR-0052

## 1. 规则（刻意保守）

`rewireTaskDependencies(taskId, dependsOn)`：

- **安全点**：存在在途任务时拒绝（`not-safe-point`）；
- 只允许 `pending` / `blocked` 节点（`running`/终态拒绝）；
- 新依赖必须已存在、不含自身；
- **重连后必须无环**；校验失败**回滚**原依赖；
- 若节点原为 `blocked` 且新依赖全部 `done` ⇒ 自动回到 `pending`（可运行）；
- 成功即 `revision+1` 落盘。

入口：`DagScheduler.rewireTaskDependencies` → 编排器 → 控制器 → 门面
`rewireMissionTaskDependencies(missionId, taskId, dependsOn)`；仅同进程运行中的 mission。

## 2. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 11/11
  环被拒且回滚（t1 依赖改 t3 失败后仍为 []）；
  重连 t3→[t2] 成功并落盘；
  未知依赖拒绝；
  blocked 任务重连到已满足依赖 ⇒ 自动 pending；
  有在途任务 ⇒ not-safe-point。
tests/core --maxWorkers=2 → 471 files / 3641 tests 全通过
typecheck / lint / build → 全绿
```

## 3. 仍未支持（ADR-0052 剩余）

- **运行中重连**（有在途任务时改依赖）：会与正在执行的下游选择产生竞态，需更强一致性设计；
- **批量重连 / 整图替换 / 回滚图**；
- 重连后的**目标模式联动**（V/证据/重规划不重算）；
- 图变更历史（只保留最新依赖，revision 计数在链上）；
- 真实 mission 演练（需同进程宿主）。

## 4. 语义提示

重连只改"这个任务等谁"；**不会**自动重跑已完成的下游，也不会撤销已产生副作用；
若被重连的任务已经在别处被引用为依赖，其下游仍按 `done` 判断，不会因边变化而回退。
