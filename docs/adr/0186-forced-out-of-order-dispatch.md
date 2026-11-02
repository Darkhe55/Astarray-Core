# ADR-0186 显式乱序派发（R128，2026-11-02）

- 状态：**已实现**（用户显式请求才允许；默认仍拒绝）
- 来源：用户"做1"（剩余缺口 1：乱序派发）
- 相关：ADR-0185（优先派发）、ADR-0052（运行中改图仍不支持）

## 1. 边界

新增的是**显式乱序派发**：调用方必须传 `allowUnmetDependencies: true`，
调度器才会在依赖未完成时启动指定任务。默认路径**行为不变**（`dependencies-unmet` 拒绝）。

不改变的事实：
- 依赖边**不改**；
- 下游仍要等所有依赖 `done` 才开始；
- **运行中改图（增删节点/改依赖）仍不支持**（ADR-0052）；
- 拒绝条件仍包括：任务不存在、非 `pending`、已在运行。

## 2. 语义与风险（写清）

强制先跑一个依赖未完成的任务，意味着它可能在**上游产出尚未就绪**时执行；
这是调用方（用户/宿主）显式承担的风险，编排器会 `onUserEscalation` 留下一条说明。

## 3. 实现

| 层 | 变更 |
|---|---|
| `DagScheduler` | `preferTaskDispatch(taskId, {allowUnmetDependencies?})`；新增 `forcedDispatchTaskIds`；`scheduleRound` 先启动 forced（尊重并发槽） |
| `MissionOrchestrator` | 透传选项；`forced-dispatch` 接受时升级说明并 `wake()` |
| `MainController` / 门面 | `dispatchMissionTask(missionId, taskId, {allowUnmetDependencies?})` |

## 4. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 5/5
  默认依赖未完成仍拒绝；显式乱序 ⇒ 先启动 t2、t1 保持 pending。
tests/core --maxWorkers=2 → 471 files / 3635 tests 全通过
typecheck / lint / build → 全绿
```

## 5. 未完成

- **运行中改图**（增删节点/改依赖/重算 ready）仍不支持（ADR-0052，需单独立项）；
- 乱序派发没有二次确认/审批（一次布尔开关）；
- 没有真实 mission 的乱序演练（需同进程宿主触发）；
- 下游"依赖未完成但已被乱序满足"的语义没有额外建模（下游只认 `done`）。
