# ADR-0194 确定性图变更演练（R136，2026-11-03）

- 状态：**已实现并稳定通过**（不依赖真实模型）
- 来源：用户"写"（补 R134/R135 的端到端验证缺口）
- 相关：ADR-0190（审计）、ADR-0191/0192/0193（联动与接线）

## 1. 为什么之前拿不到窗口

真实模型任务在几十毫秒到几秒内完成，组边界的安全点窗口极短（且模型当晚连续失败），
无法稳定在"有在途任务=0、mission 仍活动"时注入。

## 2. 确定性方案

用**假 Provider + 权限询问**制造稳定安全点：

1. 假 HTTP 服务第一次请求返回写工具调用（`createProjectFile`）；
2. assist 默认权限 ⇒ **权限询问** ⇒ 任务被 `blocked`、在途领取释放；
3. mission 仍在活动（等待裁决）⇒ `claimedTaskIds.size === 0` = **安全点**；
4. 此时注入 `T-99` ⇒ 应被接受；
5. 断言：
   - 任务链含 `T-99`；
   - `task-graph-changes.jsonl` 有 `inject:T-99`；
   - 目标状态 `requiresReplanning=false`、`pauseReason=null`、`lastPotentialValue=1`
     （mapped `T-001` 未完成，V 未上升 ⇒ 不暂停）。

测试：`tests/core/integration/graph-change-deterministic-drill.test.ts`（1/1，约 0.5s 断言窗口）。

## 3. 验证

```
graph-change-deterministic-drill.test.ts → 1/1
tests/core --maxWorkers=2 → 471 files / 3649 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 覆盖与未覆盖

**覆盖**：
- 权限阻塞期注入被接受（安全点语义）；
- 图变更审计真实落盘（含 mission 过滤）；
- 图变更通知→运行时→目标状态：**V 未上升时不暂停**（联动真实走通）。

**未覆盖**：
- **V 上升 ⇒ 暂停**分支：本夹具中 mapped 任务未完成，V 不会上升；
  需要"已映射任务 done → 图变更使其失证"的构造（当前安全图操作做不到）；
- 删除/修订/重连的同样演练（只演练了注入）；
- 暂停后的恢复流程。
