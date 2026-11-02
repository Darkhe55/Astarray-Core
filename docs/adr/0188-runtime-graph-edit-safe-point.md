# ADR-0188 运行中改图：安全点注入与删除叶子任务（R130，2026-11-02）

- 状态：**已实现**（注入 + 删除 pending 叶子；改依赖仍不支持）
- 来源：用户"继续"（运行中改图的剩余一半）
- 相关：ADR-0187（修订 pending 内容）、ADR-0052（结构性缺口）、ADR-0185/0186

## 1. 新增能力

| 操作 | 规则 |
|---|---|
| **注入任务** | 只在**安全点**（无在途任务）；新 id 不得重复；依赖必须已存在；追加后 `revision+1` |
| **删除任务** | 只允许 `pending` 且**无任何节点依赖它**的叶子任务；被依赖 ⇒ 拒绝（不产生悬空依赖）；运行中 ⇒ 拒绝 |

入口：`MissionOrchestrator.injectTaskBySpec` / `removeTaskByTaskIdentifier` →
`MainController.injectMissionTask` / `removeMissionTask` → 门面同名方法。
仅同进程运行中的 mission；跨进程 `mission-not-active`。

## 2. 刻意不支持（ADR-0052 核心）

- **改依赖**（重连/重排偏序）；
- **删除有依赖者的节点**（需要同时重连）；
- **替换整图 / 回滚图**；
- 在途任务上进行图变更（必须等安全点）。

这些不是"没时间"，而是会改变偏序语义与在途一致性，需要独立设计。

## 3. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 8/8
  注入落盘；重复 ID 拒绝；有在途任务时 not-safe-point；
  删除 pending 叶子成功；被依赖拒绝；运行中 task-running 拒绝。
tests/core --maxWorkers=2 → 471 files / 3638 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- 改依赖/删中间节点/换图（ADR-0052 核心）；
- 注入后没有"重新规划/重算 V"（目标模式不感知新任务）；
- 删除不保留历史（链上直接消失，revision 只增）；
- 无真实 mission 演练（需同进程宿主）；
- 控制器对 scheduler 用了 `as unknown as` 类型断言（内部接线，运行时安全但类型上不严谨）。
