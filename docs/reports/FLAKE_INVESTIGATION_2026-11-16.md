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

## 第三轮：把租约接管做成真正互斥（修好了一处真竞争）

### 现象

修好用例的"客观重叠"后，`cluster02-cross-process-lease` ① 在**满载门禁**下仍然红：

```text
两个实例争抢 ⇒ 只有一个构建，另一个 busy   // 偶发两个都 built
```

### 定位

不是用例的问题，是租约实现的残留窗口：`tryAcquire` 是"读 → 判断无主 → 写 + 写后回读 + 5ms 让出"。
两个实例可以**依次**完成 写→回读→放行，于是都认为自己是持有者。5ms 让出只是压窗口，不是互斥。

### 修法：接管临界区用**排他创建**串行化

```text
tryAcquire:
  ├─ 已有有效租约？ → 同持有者幂等复用 / 否则 held-by-other
  └─ 接管：
       fs.open(lease.lock, "wx")        // 排他创建，只有一方能成功
         ├─ 拿到 → 双检租约 → 写新租约（token+1）→ 关闭并删除守卫
         └─ 拿不到 → 5ms 重试（最多 20 次）→ 仍失败 → held-by-other
```

配套处理：

- 守卫目录先 `mkdir -p`（否则首次运行 ENOENT，被误判成 held-by-other——这条在压测时 10/10 复现过）；
- 守卫**陈旧**（持有者崩溃，>5s）视为可清理，避免永久 blocked；
- 守卫是毫秒级临界区的空文件，不含用户数据。删除它需要在破坏性 API 守卫白名单里登记理由
  （`core/src/orchestration/coordination-partition-lease.ts`，tokens `["unlink"]`）——
  这与既有 `mission-lease-store` 的 `rm` 白名单同一性质。

### 验证

- 3 个租约/消费用例连跑 10 次：**0 失败**（修前 10/10 红或偶发红）；
- 全量门禁：**805 files / 5328 passed + 3 skipped，exit 0**。

### 这轮真正回答了什么

"门禁偶发翻红"里，**至少有一类**是我自己新写的并发用例暴露的**产品级 TOCTOU**，
而不是单纯的机器负载。修复后该文件稳定。

## 仍然未确认

- `graph-change-deterministic-drill` 的暂停路径（追踪代码已回退，未复现）；
- `anthropic-messages-runtime` 的低频失败（约 1/8~1/20，尚未抓到现场）。

## 第四轮：长循环采集，抓到两处失败现场

20 次重复（保存每轮输出）结果：

| 文件 | 失败 |
|---|---|
| `graph-change-deterministic-drill` | **4/20** |
| `anthropic-messages-runtime` | **1/20** |

### A. graph drill：`ENOENT ... goal-mode/.mission-bindings.json.<pid>...tmp`

失败栈指向 `submitTask`，但错误是**临时文件 open 失败**：

```text
任务提交失败: ENOENT: no such file or directory, open '...\goal-mode\.mission-bin...tmp'
```

含义：`writeAtomicJson` 先 `mkdir -p` 再 `open(tmp)`，只有在**目录被并发删除**时才会 ENOENT。
删除者是用例的 `afterEach`（`fs.rm(stateDirectory, ...)`）——它固定只等 200ms，
而 `application.shutdown()` 返回后仍有后台原子写在飞。

**修法（测试侧，不动产品语义）**：收尾前轮询"目录内没有 `.tmp` 残留"（最多 5s）再删。
实测：**12/12 通过**（修前 4/20 失败）。

**这暴露的产品问题（未修，已记录）**：`shutdown()` 不保证"后台写已收敛"，
调用方只能靠沉降窗口。真正的修法是让 shutdown await 在飞写，属于更大改动。

### B. anthropic-messages-runtime：`provider-network-error`（连不上本地假服务）

失败现场：同一轮里 ⑤⑥⑦⑧ 连续四个用例全部 `provider-network-error`。

已做的一处修复：`afterEach` 原先 `server.close()` **不 await**，关闭是异步的，
下一个用例 `listen(0)` 可能撞上仍在关闭的端口/套接字。改为 await 关闭 + `closeAllConnections()`。

结果：**1/20**（修前也是 1/20 量级）——**没有解决**，说明另有原因（可能是端点复用或连接池缓存）。
如实记录，不宣称已修。

## 小结：抖动的三类根因（目前证据）

| 类别 | 实例 | 状态 |
|---|---|---|
| 产品级并发缺陷 | 租约接管不互斥 | **已修**（排他守卫） |
| 用例收尾不收敛 | drill 删除目录撞后台写 | **已修**（等 `.tmp` 消失） |
| 未确认 | anthropic 连接失败 | **未修**，1/20 |

## 第五轮：`anthropic-messages-runtime` 的根因（已修）

上一轮只做到"await 关闭"，1/20 仍在。继续查运行时侧后定位到真正原因：

```text
每个用例 listen(0) 起新服务 → OS 会复用刚释放的端口
全局 fetch（undici）按 origin 池化连接 → 复用旧 socket
旧 socket 指向已关闭的服务 ⇒ provider-network-error（四个用例连续失败）
```

即：**不是负载，也不是关闭时机，而是"端口复用 + 连接池"的组合**。

**修法**：假服务端显式回 `connection: close`，让连接不可池化。

实测：**0/20**（修前 1/20，且失败时是同一轮连续 4 个用例一起红，与连接池被污染的表现一致）。

## 抖动根因总表（最终）

| 类别 | 实例 | 证据 | 状态 |
|---|---|---|---|
| 产品级并发缺陷 | 协调分区租约接管不互斥 | 反例满载稳定复现 | ✅ 已修 |
| 用例收尾不收敛 | drill 删目录撞后台写 → ENOENT | 20 次采样 4 次失败 | ✅ 已修（12/12） |
| **测试连接池污染** | 端口复用 + undici keep-alive | 同一轮连续 4 用例失败 | ✅ 已修（0/20） |

## 第六轮：`shutdown()` 的后台写收敛（已实现，2026-11-17）

前几轮实证：`shutdown()` 等在途编排收敛，但**不等**事件回调里的
`void (async () => …)()` 派生写。真实后果是"进程退出时最后一次派生写静默丢失"
（目标暂停标记 `requiresReplanning` 可能没落盘）；测试里表现为删除目录后 `open(.tmp)` ENOENT。

### 实现

| 项 | 位置 |
|---|---|
| `PendingWriteTracker`（登记 + 有界 drain） | `orchestration/pending-write-tracker.ts` |
| 三处事件回调改为 `backgroundWrites.track((async () => …)())` | `application/application-runtime.ts` |
| `shutdown()` 末尾 drain（5s 上限；不完整时输出结构化告警，不挂死） | 同上 |
| 反例 5 条（等待完成 / 超时不挂死 / 失败不产生未处理拒绝 / 空集合 / 返回原 Promise） | `tests/core/unit/pending-write-tracker.test.ts` |
| 守卫 2 条（不得再有裸 `void (async`；drain 必须在 supervisor 之后） | `tests/architecture/shutdown01-background-writes.test.ts` |

### 边界（如实）

- 这是**收敛**修复，不是"零丢失"：SIGKILL / 断电仍会丢；
- drain 只覆盖**登记过的**回调写；其它路径若有未登记的 fire-and-forget 写，不在覆盖范围；
- 5s 上限是有意的：关闭不得被未知挂起拖死。

全量门禁：**810 files / 5361 passed + 3 skipped，exit 0**。
