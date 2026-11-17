# WIRING-04 交付报告（2026-11-18）

**性质**：收尾报告。逐检查点列出**做什么 / 证据在哪 / 是否闭环 / 为什么没闭环**。
卡：`docs/tasks/WIRING04_DURABLE_CONSUMPTION_AND_CONTEXT_REPAIR.md`（施工记录见其 §8–§24）。

## 1. 总览

| 检查点 | 状态 | 一句话 |
|---|---|---|
| 01 可靠消费（意图先持久化 / 对账 / 证据原子性） | **主体完成，1 项阻塞** | 意图先写、对账以权威证据为准、证据与状态同一次写；**revision/执行尝试核验缺消息字段** |
| 02 请求投递事实 | **完成** | 适配器发布生命周期；回执按迭代幂等留痕；投影可补写 |
| 03 完成门禁不得停在局部判定 | **主体完成** | 单一校验函数 + 受控凭证（两条持久化入口都强制） |
| 04 上下文包（方案 C） | **解析与接线完成，1 项阻塞** | 精确映射解析 + 固定 revision + 哈希 + 预算；**精确映射写入方不存在** |
| 05 关闭节点回访 | **工具与候选完成，1 项缺口** | 只读工具 + 最小候选；**依赖/产物关联候选缺反查索引** |

## 2. 逐检查点证据

### 01 可靠消费

| 结论 | 证据 |
|---|---|
| 意图先于权威状态；写失败不应用；同键异内容记 blocked | `coord01-consumption-runner.test.ts` ⑬⑭ |
| 崩溃后按**权威应用证据**对账，不重放 | `coord01-business-application-crash.test.ts` ⑤⑥；`wiring04-startup-reconciliation.test.ts` ①（真实入口 `runStartupRecovery`） |
| 旧状态迁移：applied 无意图 ⇒ 有证据补 completed / 无证据标 `needs-reconciliation`，迁移前备份 | `wiring04-legacy-migration.test.ts` ①–④ |
| 证据与状态同一次原子提交（任务链文档内） | `coord01-task-state-application.test.ts` ⑤⑥ |
| **阻塞**：revision/执行尝试核验 | 消息结构无 `taskRevision` / `executionAttempt`（同 COORD-02 根因），消费端不猜 |

### 02 请求投递

| 结论 | 证据 |
|---|---|
| 适配器在传输边界发布 dispatched / acknowledged / outcome-unknown | `request-lifecycle-adapter.test.ts` ①②③ |
| 请求前取消 ⇒ `failed-before-dispatch` 且不调用传输 | `runtime.test.ts`「取消信号终止循环」+ `coord01-context-delivery-wiring` ⑥ |
| 只按事实落回执（acknowledged⇒delivered、失败无确认⇒unknown、其余 pending） | `coord01-context-delivery-wiring.test.ts` ②⑤⑥ |
| 载荷指纹落账 | 同文件 ② + `context-delivery-attempts.test.ts` |
| 多迭代分别留痕、同请求幂等 | `context-delivery-attempts.test.ts` ①② |
| 先回执后投影；投影失败启动补写（无证据不补） | `wiring04-delivery-projection.test.ts` ①② |

### 03 统一完成门禁

| 结论 | 证据 |
|---|---|
| 两条入口共用 `evaluateAuthoritativeCompletion` | `coordination-completion-gate.test.ts` ⑬⑭ + 任务卡 §P1-2 收口 |
| 内存调度器入口要求受控凭证 | `wiring04-completion-authorization-guard.test.ts` ①②③ |
| 持久任务链入口要求同一凭证 | 同文件 ①b；`coord01-task-state-application.test.ts` ①② |

### 04 上下文包（方案 C）

| 结论 | 证据 |
|---|---|
| 精确映射解析（缺映射/声明丢失/未声明三态）+ 固定 revision + 内容哈希 | `context-pack-resolution.test.ts` ①–⑥ |
| 声明有包却读不到 ⇒ 阻塞；未声明 ⇒ 无包运行 | `context-prompt-assembler.test.ts` ①②③ |
| 关联不精确（只有 `*`）如实报告，不被当作未声明 | 同文件 ④⑤ |
| **阻塞**：精确映射写入方 | `main-controller.ts` R124 只写 `missionTaskIdentifier: "*"`；投影侧未产出精确映射 |

### 05 关闭节点回访

| 结论 | 证据 |
|---|---|
| 只读工具 `recallClosedContext`（权限 `project.read`、范围分类本地只读） | `scope-tool-mapping.test.ts`、`tool-registry.test.ts` |
| 身份由 harness 注入；模型自带身份被拒；非法参数明确拒绝 | `recall-tool-call.test.ts` ①–⑤ |
| 找不到节点 ⇒ 最多 5 条候选（仅标识+revision，无正文），来源限本人胶囊 | 同文件 ⑥⑦ |
| 回访块可进提示词（显式提供时） | `context-prompt-assembler.test.ts`（WIRING-04-05 两条） |
| **缺口**：依赖/产物关联候选 | 仓库无"从依赖/产物反查节点"的索引 |

## 3. 关键提交（均为本地提交并已推送）

```text
4aad2408 docs: specify durable consumption and context wiring repairs
a3c5461e fix(coord): persist the business intent before touching the authoritative state
2c4d082d feat(coord): reconcile pending business intents against the authoritative evidence
a1e583cc fix(coord): reconcile startup recovery against the applied message evidence
9a3215ef feat(coord): migrate legacy applied messages and prove recovery does not replay
15244a9f feat(runtime): publish request lifecycle facts from the transport boundary
8cc06039 feat(context): resolve the task context pack through the exact mission to sequence mapping
ddaeb32c feat(coord): record the payload fingerprint with the delivery receipt
8df8ea8e fix(coord): write the delivery receipt before the mailbox projection and backfill it on startup
edf844c4 feat(coord): record one delivery receipt per acknowledged iteration
3742ef5d feat(context): let explicitly recalled closed-node blocks into the prompt
39b82dcc fix(coord): require an authoritative completion proof before marking a task done
ffbf6e61 fix(coord): require the same completion proof on the task chain writer
c1a16763 feat(tools): expose closed-node recall as a read-only tool
3476c687 feat(tools): return minimal recall candidates when a closed node is not found
b6c507e5 feat(coord): record message application evidence in the same task chain write
7daf92aa feat(context): report an imprecise pack mapping instead of treating it as no pack
```

## 4. 门禁

| 项 | 结果 |
|---|---|
| `npm run check:low-parallel` | **825 files / 5440 passed + 3 skipped，exit 0**（最后一次全量） |
| `npm run verify:privacy` | `privacy-ok` |
| 已知抖动 | `graph-change-deterministic-drill`、`nodectx01-multi-model-fake-service-e2e`、`anthropic-tool-loop-failclosed`、`g3a-positive-path`、`history01-run-history-e2e`：隔离重跑均通过 |

## 5. 未闭环项与决策要点（需要外部输入）

| # | 项 | 缺什么 | 谁补 | 补完的验收判据 |
|---|---|---|---|---|
| 1 | 精确映射写入 | 投影侧按 mission task 逐条写映射（当前只有 `*`） | 任务发布/投影子系统 | 开启 `isContextPackMappingRequired` 后真实任务仍能启动，且包注入来自精确节点 |
| 2 | revision/执行尝试核验 | `FeedbackMessage` 增 `taskRevision` / `executionAttempt` | 消息生产方（COORD-02） | 旧 attempt 完成新任务被拒；撤权后旧 epoch 消息不携带 |
| 3 | 跨存储原子性 | 意图台账与任务链合并为统一提交单元 | 存储层设计 | 两写之间强杀进程，重启后既不重复副作用也不丢业务更新 |
| 4 | 依赖/产物关联候选 | 从依赖关系、产物登记反查上下文节点的索引 | 上下文图/产物子系统 | 候选可回溯到依赖或产物，且不含正文 |

## 6. 明确未做的事（避免误读）

- 未在消费端推断 revision/执行尝试/授权（拒绝伪造）；
- 未直接给 `done` 放行任何入口（两条持久化入口都要凭证）；
- 未把"关联不精确"当成"未声明包"；
- 未用测试数量掩盖上述四项未闭环；
- 真实进程级（spawn）崩溃/双进程竞争仍未做；包级 tarball 隔离安装本轮未做（无对外导出变化）。
