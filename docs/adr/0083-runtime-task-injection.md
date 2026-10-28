# ADR-0083 运行中插入的真实安全点注入（清单第 ① 项下半场）

- 状态：部分采纳（安全点注入已实现并接线；图变更仅限"追加叶子/依赖已存在"）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ① 项
- 相关：ADR-0053（运行中插入）、ADR-0078（记账对照）

## 1. 背景

此前 `requestRuntimeTaskInsertion` 的"注入"只有两条路：
判定为 `insert-now` 且**没有** `taskGroupInsertionPort` ⇒ 直接落到"推迟到下一组"；
即便提供了端口，也没有任何地方实现它。`DagScheduler` 的图在构造时固定，**没有追加节点的方法**。

## 2. 契约（冻结）

1. **只在安全点注入**：`DagScheduler.injectTask` 要求 `claimedTaskIds.size === 0`
   （没有在途任务）；否则抛错，调用方必须**推迟到下一组**（原语义不变）。
2. **图更新受约束**：`TaskGraph.addNode` 拒绝重复 ID、拒绝**不存在的依赖**
   （避免产生永远不可运行的节点），并重新做无环校验。
3. **持久化原子**：注入后走 `updateTaskChain`（锁内读-改-写，revision +1），
   不手写文件、不跳版本。
4. **稳定标识**：注入任务 id 由插入请求标识派生（`task-runtime-insert-<hash12>`），
   同一请求重复注入返回 false（不产生第二条）。
5. **依赖过滤**：请求里的依赖 + 锚点，**只保留图中已存在的**；未命中即丢弃
   （宁可少依赖，也不留下不可运行节点）。
6. **推迟仍是默认退路**：`MainController.injectTaskIntoRunningMission` 返回 false 时，
   `requestRuntimeTaskInsertion` 继续走"登记进序列、下一组生效"。

## 3. 生产调用链（源码位置）

```
MainController.requestRuntimeTaskInsertion
├─ decideTaskGroupInsertion → insert-now?
├─ options.taskGroupInsertionPort（运行时已装配）
│  └─ MainController.injectTaskIntoRunningMission
│     ├─ activeOrchestrators.get(missionId)
│     ├─ scheduler.getKnownTaskIdentifiers()
│     └─ scheduler.injectTaskAtSafePoint(node)
│        ├─ 无在途任务？否则返回 no-safe-point
│        ├─ DagScheduler.injectTask → TaskGraph.addNode + persistChain(revision+1)
│        └─ wake()（下一轮调度即看到新节点）
└─ 返回 false ⇒ 落回"登记进序列、推迟到下一组"
```

## 4. 未完成（如实）

- **不能改已有节点的依赖/状态**：只支持"追加节点"；改序、拆包、移动锚点仍不支持。
- **安全点判定是近似**：以"没有已领取任务"为准；工具调用与领取之间的极短窗口未额外加锁。
- **没有 UI/CLI**：只能经控制面 API 触发。
- **与权威序列的一致**：注入只改 mission 任务链，**序列侧仍由 `publishOrInsertTask` 登记**；
  两边仍可能短暂不一致（ADR-0078 的对照能看出差异，但不自动修复）。
- **未验证**：没有跑过"安全点注入成功""有在途任务 ⇒ no-safe-point""依赖不存在 ⇒ 拒绝"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
