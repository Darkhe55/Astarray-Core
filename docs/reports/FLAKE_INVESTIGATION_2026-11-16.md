# 门禁抖动追踪：首轮结论（2026-11-16）

长期现象：全量门禁偶发翻红，隔离重跑必绿。此前只能人工重跑，没有可复算数据。
本轮加入 `scripts/flake-tracker.mjs`，把"重复跑同一批文件"变成数据。

## 复算方式

```powershell
node scripts/flake-tracker.mjs --runs 3
# 或指定文件
node scripts/flake-tracker.mjs --files tests/core/integration/graph-change-deterministic-drill.test.ts --runs 10
```

产出：`docs/reports/FLAKE_TRACKER_2026-11-16.json`（每个文件 N 次运行、失败数、耗时、失败尾部输出）。

## 本轮证据

| 观察 | 数据 |
|---|---|
| 已知抖动集 5 文件 × 3 次 | `graph-change-deterministic-drill` **1/3 失败**，其余稳定 |
| `anthropic-messages-runtime` 单独重复 | 首轮 8 次中 1 次失败；随后 23 次连续通过 |
| **全量串行**（`vitest run --maxWorkers=1`） | **仍然抖红一次**（`anthropic-messages-runtime`） |

### 结论 1：抖动不是"并发太高"单一原因

串行全量也会红，说明至少有一部分抖动与**并行度无关**，而是与
"同一进程内前面的用例留下的状态/机器负载"或"用例自身的时序竞争"有关。

### 结论 2：已捕获一处可定位的时序竞争

`graph-change-deterministic-drill` 的失败断言：

```text
expect(goalState.requiresReplanning).toBe(true);   // 实际 false
```

用例已轮询 30s（`deadline = Date.now() + 30_000`），仍未等到。也就是说
**不是"等得不够久"，而是这条暂停路径没有被触发**。可疑原因（待验证）：

- 注入任务（`injectMissionTask`）发生时，mission 可能已经走到终态；
- 暂停/重规划联动只在 mission 活跃期写入，终态后不再写 ⇒ 断言永远等不到。

这条如果成立，正确修法是让用例在"mission 仍活跃"的前提下注入（例如让假服务端
在注入完成前不返回完成事件），而不是继续加长超时。

## 尚未完成

1. 上述暂停路径的确认（需要在 mission 生命周期上加观测点，而不是继续猜）；
2. `anthropic-messages-runtime` 的低频失败仍未捕获到失败现场（约 1/8~1/20，抓取时未复现）；
3. 没有把"抖动集合"接入门禁自动重跑——本轮只做追踪，不做自动重试（自动重试会掩盖问题）。

## 诚实边界

- 本报告**不**声称抖动已修复；
- `FLAKE_TRACKER` 数据的样本量很小（每文件 3 次），只能作为方向证据。

## 第二轮：追踪尝试与一个自造抖动

### 1. 给暂停联动加观测（临时）

在 `onMissionGraphChanged` 里加了 `ASTARRAY_DEBUG_GRAPH_CHANGE=1` 才输出的追踪
（记录 goal 绑定、目标状态、重算后的 V）。目的：判断 `requiresReplanning` 为什么没写。

结果：**8 次单独重复全绿，追踪没有输出**；随后开着追踪跑全量（`--maxWorkers=2`），
`graph-change-deterministic-drill` 也没红（红的是另一处）。也就是说这一轮没有复现，
**暂停路径的原因仍未确认**。

追踪代码已回退，不留在仓库里（没有证据就不该留调试分支）。

### 2. 顺带发现：我自己新加的用例也会抖

同一次全量里红的是 `tests/core/integration/cluster02-cross-process-lease.test.ts` ①：

```text
两个实例争抢 ⇒ 只有一个构建，另一个 busy   // 负载高时可能两个都是 built
```

原因：用例假定两次构建真的**重叠**，但 `Promise.all` 下若第一个很快完成并释放租约，
第二个会在释放之后才拿到租约 ⇒ 两个都构建成功 ⇒ 断言失败。

**已修（不是放宽断言）**：让假事件源每次读页 `await 50ms`，使第一次构建客观上有持续时间，
两个实例必然重叠 ⇒ "另一个拿到 busy" 变成确定性结论。连续 6 次全绿。

教训：写"并发"用例时，必须让并发**客观发生**，而不是假设调度会重叠。

## 仍待确认

- `graph-change-deterministic-drill` 的暂停路径（需要能让它稳定复现的方法：例如在负载下重复跑该文件并保留追踪）；
- `anthropic-messages-runtime` 的低频失败现场。
