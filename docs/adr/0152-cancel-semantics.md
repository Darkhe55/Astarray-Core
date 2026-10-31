# ADR-0152 取消语义：编排器专属终态 + CLI 干净收口（R88，2026-11-01）

- 状态：已采纳（两处修正；持久化 `cancelled` 残留仍未定位）
- 来源：用户"按这个做"（ADR-0151 建议：cancel 不再写终态）
- 相关：ADR-0151（关闭时序）、ADR-0150（终态单点）

## 1. 改动

1. **`cancelMission` 不再抢先写终态**：
   - 有活动编排器 ⇒ 只发停止信号并 `await scheduler.cancel()`（编排器按 `hasFailedTask`
     写 `blocked/cancelled`）；
   - 收口后若仍非终态（测试替身/异常路径）⇒ 补写 `cancelled`（仍走终态单点，不覆盖已有终态）；
   - 无活动编排器 ⇒ 由控制器写 `cancelled`（此时没有别的写入者）。
2. **CLI 提交失败干净收口**：`run` 在 `submitTask` 抛错时只打印一行错误并以
   `USAGE_ERROR` 退出，**不再打印 Node 栈**（例如启动前门禁阻断）。

## 2. 真实复跑

- 启动前阻断（目标已暂停 + `--goal-enforce`）：CLI 输出一行 `任务提交失败: 目标门禁阻断派发：…`
  并以退出码 2 结束（修复前是未捕获异常 + 栈）。
- 预算耗尽（新目标，上限 1）：CLI 输出 `status: blocked`；目标 `isPaused`、`consumedToolCalls: 1`。

## 3. 仍未解决（如实）

**持久化 `summary.json` 仍是 `cancelled`**（`mission-59ec4da5`）。
说明还有一条未观测到的写入路径把 cancelled 落库；本轮加的"编排器专属终态"没有消除它，
只是让 controller 不再主动抢写。已尝试临时日志（`[D-TERM]`）但未捕获到该路径，
下一轮需要更细的写入追踪（例如在 `MissionManager.updateMissionStatus` 打印调用栈）。

## 4. 验证

- `tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**（含 `main-controller` 10/10、
  G5 2/2）；
- `typecheck` / `lint` / `build` 绿；
- 真实复跑：CLI 阻断输出干净、预算目标状态正确。
