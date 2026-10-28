# ALIGN-02：统一偏序集、任务组和次级持续调度

日期：2026-10-27。状态：in_progress（01 已交付；02–03、05–07 部分交付；均 implemented-unverified；2026-10-28）。

执行约定：只修改本卡负责范围；先备份覆盖前文件，保留并行工作。每轮一个编号步骤，超过 3 小时拆分剩余步骤继续。允许更新本卡与所属仓库索引，不授权安装依赖、提交推送或调用真实付费模型。本轮沿用用户要求，不编写/运行测试，不构建或人工验收；按源码调用链交付证据，完成只能标 implemented-unverified，不得宣称运行验证通过。既有测试和 CI 不删除、不弱化。发现相关实现已存在则复用，不重复造轮子；缺少可信授权或遇并行覆盖冲突只阻塞对应步骤。具体模型是否曾替换设计无可靠证据，不作来源归罪。

前置：ALIGN-01。负责 TaskSequenceManageController、ConversationTaskInsertionController、SecondaryContinuousDispatchLoop、instruction-window 与默认任务提交装配。
## 固定实现
1. 用户任务先登记于目标次级个体记忆中的版本化偏序集，再建立 mission 执行投影；mission 可为一次任务组执行，不是另一份可独立调序的权威待办。保留原指令、来源与任务 ID 映射。
2. 默认执行不再用固定 T-001 代替全部规划。次级读取任务目标和必要项目摘要，形成有依赖的执行节点及验收要求；已有分解直接复用。模型建议经本地 schema、循环与优先级校验后提交，不能伪造用户最高优先来源。
3. 从 ready set 按有效优先级选择任务，依赖先满足；用户层最高，同层稳定排序。不得把未满足依赖的任务靠置顶强行执行。个体任务链打包复用原包契约；一次模型任务组可引用一个或多个已就绪包，不删除包内边界。
4. 指令窗口仅限流/管理当前活动组。运行中插入记录目标组、锚点、预期 revision、幂等键；本地校验后在安全上下文边界注入尚未执行部分。不得重复运行组内已完成任务，不直接改写已发出的工具调用；无法在本组合法插入的后继保留在同一序列等待下一组，并给出原因。
5. 替换 dispatchChain 恒 false 与占用数恒 0 为真实编排器/资源租约接口。任务领取须原子且幂等；派发失败释放领取或记录可恢复错误，不能丢失任务或占住虚假槽位。
6. 新建或复用三级 Agent 必须绑定具体个体、任务包和唯一直属上级；仅显式选取必要附件，不共享整段上下文。调度额度限制是配置资源预算，不把 4 个槽位/32 个队列长度变成架构个体数量硬限制。
7. 持续调度由就绪、完成、依赖解锁、时段恢复与资源释放事件唤醒；无进展有界退避，循环/预算守卫复用既有组件。没有工作时不忙轮询，失败不形成无限重派。
## 交付与关闭条件
普通提交、直投、运行中插入、终态回执均回到同一偏序权威状态。提供源码映射，注明准入状态与任务状态职责。旧窗口 API 保留兼容适配，不再另建三态模式或第二队列。


## 检查点记录

### 01 用户任务先入权威序列、再建 mission 投影——implemented-unverified（2026-10-28）

**审查发现（实测）**：`AgentTaskSequenceStore` / `TaskSequenceManageController` 实现完整，
但 `publishSequence` **全仓零调用**；`handleUserMessage` 直接创建 mission（固定 T-001），
mission 成了唯一"待办" —— 正是本卡要纠正的口径。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 控制面 | `packages/core/src/orchestration/task-sequence-controllers.ts` `publishOrInsertTask` | 序列不存在则发布首任务，存在则插入；同 taskId 幂等；竞态如实失败 |
| 入口 | `main-controller.ts` `registerUserTaskInSequence` | 先登记（来源 user / 层级 0 / 原文作标题 / `externalReference=mission:<id>`），成功后建 mission |
| 映射 | `mission-manager.ts` `taskSequenceIdentifier` + `originalTaskIdentifier` | 摘要可双向追溯；旧摘要按"无序列投影"处理 |
| 查询 | `MainController.getMissionTaskSequence(missionId)` | 只读投影映射（含 sequenceRevision / isSequenceCreated） |
| 契约 | `docs/adr/0049-authoritative-task-sequence-before-mission.md` | 顺序、映射、匿名不登记、assist/devolve 分开 |

**边界（如实）**：只接 **assist**；devolve 无下级偏序集，本轮不编"次级序列"；
默认执行仍用固定 T-001（02-02）；调度器尚未消费 ready set（02-03/05）；
未跑端到端与并发竞态实测。

**验证状态**：未编写/未运行测试、未人工验收；`npm run typecheck` exit 0、
`npx eslint <本批文件>` exit 0、`npm run build` 成功。⇒ **implemented-unverified**。

### 02 任务分解：本地强制校验 + 显式降级——**部分交付**（2026-10-28）

**审查发现**：`decomposePromptForScriptedRun` 固定生成 T-001 单节点，等于"没有规划"。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 校验契约 | `packages/core/src/orchestration/task-decomposition-contract.ts` | 严格白名单字段、节点 1..12、id 唯一合法、描述与验收非空、依赖存在且无环（报完整环路）、工具子集；产出节点恒 pending / assignedAgentId null |
| 候选稿生产器 | `model-task-decomposition-planner.ts` | 单轮规划提示词 + 120s 预算 + JSON 抽取；拿不到 JSON 即失败，不编造 |
| 三种结果 | `main-controller.ts` `planTaskDecomposition` | `model` / `single-node-fallback`（含原因 + `[规划降级]` 提示）/ `legacy-single-node` |
| 落盘 | `mission-manager.ts` `taskPlanningOutcome` + `taskPlanningFallbackReason` | 降级不得伪装成"已规划" |
| 装配 | `application-runtime.ts` | `isModelTaskPlanningEnabled` **默认 false**；开启且存在 worker 运行时才构造 |

**为什么只是部分交付**：默认关闭 ⇒ 默认路径仍是单节点（摘要如实标 `legacy-single-node`）。
开启后才会真正规划；而本卡口径**禁止运行模型验证**，默认开启等于把未验证行为推给所有任务，
故不做。项目摘要来源（`projectSummaryProvider`）也尚未装配。

**未做**：真实模型验证、项目摘要接线、复用既有分解、调度消费分解结果（02-03/05）。

**验证状态**：未编写/未运行测试、未调用真实模型；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 03 ready set 工作单元选择——**部分交付**（2026-10-28）

**审查发现**：`getReadyTaskIds()` 只按 `(priorityTier, sequenceOrdinal)` 排序，
而 `explainOrder()` 声称"必要前驱可先行"——**没有任何代码实现该选择**；
任务包也从未被当作派发单位挑选过。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 选择契约 | `packages/core/src/orchestration/ready-task-group-selection.ts` | 只从 ready set 取；有效优先级 = min(自身, 可达后继)；包整包参与、不拆包；预算按单元；三级稳定排序 |
| 只读入口 | `task-sequence-controllers.ts` `TaskSequenceStatusController.selectNextTaskGroup` | 与 `getSnapshot` 同口径鉴权；不改 revision |

**关键不变量**：未满足依赖的任务**永不**进入结果（置顶/提权/包内顺序都不能绕过）；
包内任一任务非 pending 或首任务未就绪 ⇒ **整包推迟**并给原因。

**未做（如实）**：**没有派发消费者**（`dispatchChain` 恒 false、占用恒 0 属 02-05）；
未接执行者容量/租约；`createTaskBundle` 仍无生产调用方；未做 DAG+包+阻塞的端到端实测。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 05 派发循环去假值 + 原子领取——**部分交付**（2026-10-28）

**审查发现（实测）**：装配层写死了 `dispatchChain: async () => false` 与
`currentOccupiedSlots: () => 0`；而且 `runRound` **从未被任何生产代码调用** ——
真正的执行由 `MissionOrchestrator` 内部的 `dagScheduler.scheduleRound()` 驱动。
即：这个"持续调度循环"目前是**第二套调度器**。

**已交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 真实占用 | `unbounded-agent-registry.ts` `getOccupiedSlotCount()` | 缺省占用 = `running` 实例数；不再默认 0 |
| 准入单一来源 | `secondary-continuous-dispatch-loop.ts` | 排队/暂停只由注册表判定，删除循环内二次短路 |
| 按 mission 端口 | 同文件 `registerMissionPorts` | 未注册 ⇒ `blockedReason: "dispatch-handler-missing"`，不领取、不假装 |
| 原子领取 | `task-sequence-controllers.ts` `claimTask` / `releaseClaim` | revision 乐观并发；竞态返回 false（不抢占、不重复派发） |
| 失败释放 | 循环 | 派发被拒/抛错 ⇒ `releaseTask` + `releaseAdmission`，逐任务 `skippedReasons` |
| 实例归属 | `DispatchChainInput.agentInstanceId` | 执行方收口后必须回收，否则真实占用不回落 |

**未完成（如实）**：**没有真实派发端点**（orchestrator 无"按 taskId 领取并派发"的公开 API，
用 `reassignTask` 当派发是错语义），`registerMissionPorts` 无生产调用方；
权威序列的 `task-<missionId>` 与 mission 任务链**仍是两套记账**（序列任务会停在 pending）；
未做"领取 → 失败 → 释放 → 再领取"实测与并发竞态实测。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 06 运行中插入：本地判定 + 安全推迟——**部分交付**（2026-10-28）

**审查发现**：`InstructionWindowStore` 只管指令准入/排队/回执，**没有任务组插入**；
`DagScheduler` 没有插入能力（只有 finish/release/block/cancel/reassign/unblock）；
`MissionOrchestrator` 无对外插入入口 ⇒ "插进正在跑的组"没有安全执行面。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 判定契约 | `packages/core/src/orchestration/task-group-insertion-contract.ts` | 严格白名单解析；固定判定顺序（幂等 → revision → 锚点 → 组关闭 → 工具调用）；四类结果 |
| 入口 | `main-controller.ts` `requestRuntimeTaskInsertion` | 组状态取自 mission 摘要+任务链；`insert-now` 且有端口才注入，否则**登记进同一序列等待下一组**并给原因 |

**关键不变量**：不改写已发出的工具调用（组内有 running 任务即按保守处理）、
不重跑已完成任务、revision 不符拒绝（要求重读）、推迟不丢任务、幂等键防重复。

**未做（如实）**：**没有生产注入端口**（编排器/DAG 无插入能力）⇒ 目前每个请求都推迟到
下一组；幂等指纹只在进程内；`acceptanceCriteria` 未落序列节点；锚点统一退化为"用户任务前驱"；
未做端到端与并发实测。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 07 事件唤醒 / 有界退避 / 失败重派上限——**部分交付**（2026-10-28）

**审查发现**：`waitForNextWake(max)` 只有固定超时（短超时即忙轮询），`wake()` 不说明原因；
派发失败后任务回到 `pending`，**下一轮立刻再次领取** ⇒ 失败次数无上限（无限重派）。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 带原因的唤醒 | `SchedulingWakeReason`（external/task-ready/task-finished/dependency-unlocked/work-window-resumed/resource-released） | `waitForNextWake` 返回 `{reason, waitedMilliseconds}`，超时=timeout |
| 有界退避 | `getRecommendedWaitMilliseconds` | 无工作 30s 空闲；有进展 1s；连续无进展 250ms×2^n 封顶 30s |
| 失败上限 | `MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK = 3` | 达上限停手并在 `skippedReasons` 说明；成功清零；可 `resetDispatchFailureCounts()` |
| 进展统计 | `consecutiveNoProgressRoundCount` | 随每轮返回，可观测 |
| 事件源（已接） | `main-controller.ts` | mission 启动 ⇒ `task-ready`；assist/devolve 终态 ⇒ `task-finished` |

**未做（如实）**：循环仍无真实派发端点（承接 02-05）；**逐任务事件源未接**
（无 per-task 完成/依赖解锁/时段恢复/资源释放发布点）；退避未与真实时钟/取消联动；
未跑任何一次真实计时（"连续失败 3 次停手""退避序列""空闲等待"均未实测）。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。
