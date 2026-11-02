# ADR-0187 运行中修订 pending 任务（R129，2026-11-02）

- 状态：**已实现**（只改内容，不改图）
- 来源：用户"继续"（运行中改图的结构性缺口）
- 相关：ADR-0052（运行中图变更）、ADR-0185/0186（派发）

## 1. 做了什么（以及为什么只做这一半）

"运行中改图"包含：增删节点、改依赖、改任务内容。本次只实现**改 pending 任务的内容**
（`description` / `toolNames`），因为：

- 增节点：调度器已有 `injectTask`（安全点注入，R33 已存在）；
- 改依赖/删节点：会改变偏序语义与在途一致性，风险高，仍**不支持**；
- 改内容：不影响图结构，且能让"模型下一轮读到修正后的需求"。

## 2. 规则

- 只允许 `pending` 任务（`running`/`done`/`failed` 拒绝）；
- 只改 `description` / `toolNames`；不允许空描述、空补丁；
- 修改后 `revision+1` 落盘，下一次派发使用新内容；
- 仅同进程、运行中的 mission（控制器限制）；跨进程返回 `mission-not-active`。

## 3. 验证

```
tests/core/unit/dag-scheduler-preferred-dispatch.test.ts → 6/6
  修订 t2 后链内 description/toolNames 已更新；运行中的 t1 修订被拒（task-not-pending）。
tests/core --maxWorkers=2 → 471 files / 3636 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- **改依赖 / 删节点 / 替换图** 仍不支持（ADR-0052 核心部分）；
- 没有"修订历史"（只保留最新内容，revision 计数在链上）；
- 没有真实 mission 的修订演练（需同进程宿主触发）；
- 修订不触发重新规划（V/证据不重算）。
