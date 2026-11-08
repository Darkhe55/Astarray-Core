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

### 05 追加（2026-11-05）：终态回执写回权威序列

- `finalizeMissionStatus` 在写终态后调用 `syncSequenceTaskTerminalStatus`：
  从 `sequence-<ownerAgentInstanceId>` 推导所有者，以**所有者个体**身份做一次 CAS 迁移，
  把原始用户任务置为 done/cancelled/blocked；已是终态则不动；同步失败只流式告知、不掩盖 mission 终态。
- 证据：`tests/core/integration/align02-terminal-status-sync.test.ts`（轮询到同步完成，3/3 隔离稳定）。
- 公开全量 **602 files / 4201 tests** 通过（首次全量出现 1 条既有 drill 负载抖动，隔离 3/3 通过，重跑全绿）。
- **仍缺**：序列任务在 mission 运行期间不标 running（当前迁移规则 done 只允许 pending/blocked 前态）；
  真实派发端点/按 mission 注册端口（03/05 剩余）、运行中插入端口（06）、逐任务事件源（07）。

### 05 追加（2026-11-05）：真实派发端口与消费者

- 新增 `createMissionDispatchPorts`：把编排器 `dispatchTaskByTaskIdentifier`（语义是**优先派发**，
  不是立即执行）包装为 mission 端口；任一 taskId 被接受即 true；原子性由编排器自身校验（pending/依赖/幂等）。
- mission 启动（assist/devolve）时 `registerMissionDispatchConsumer`：
  注册端口 + 用 mission 任务链跑一轮 `runRound`（真实消费 ready set；派发失败只流式告知）；
  mission 终态时 `unregisterMissionPorts`。
- 运行时暴露 `secondaryDispatchLoop`（诊断/测试可见）。
- 证据：`mission-dispatch-ports.test.ts`（接受/拒绝/混合）、
  `align02-dispatch-consumer.test.ts`（注册→runRound→终态注销）；公开全量 **604 files / 4203 tests** 通过。
- **仍缺**：mission 任务链节点没有 priorityTier（本轮按 0 参与排序），需在链上引入优先级或从序列映射；
  运行中插入端口（06）、逐任务事件源（07）、失败重派实测。

### 07 追加（2026-11-05）：逐任务事件源补齐 + 行为测试

- 事件源现状（代码核对）：`task-ready`（mission 启动）、`task-finished`（收口）、
  `work-window-resumed`（时段恢复）此前已接；本轮补上
  **`dependency-unlocked` 与 `resource-released`**（任务收口时同时发出）；
- 新增测试覆盖：`notifySchedulingEvent` 唤醒返回真实原因；
  连续失败退避 250→500→1000→2000ms、达到上限 3 次后停手（`skippedReasons` 说明）、
  无工作时空闲 30s、成功后计数清零并回到 1s；
- 公开全量 **604 files / 4205 tests** 通过。
- **仍缺**：退避未与真实时钟/取消联动；"领取→失败→释放→再领取"的端到端实测。

### 06 追加（2026-11-05）：插入端口真正可达 + 双账登记

**真实缺陷**：运行时 `controllerHolder.current` **从未指向控制器** ⇒
`taskGroupInsertionPort` 永远拿到 null，运行中插入因此**永远推迟**（代码看似接好，实际不可达）。

修复：
1. 构造控制器后立即 `controllerHolder.current = controller`；
2. 安全点注入成功后，除 mission 链外**同时登记权威序列节点**
   （`task-runtime-insert-<hash>`，`externalReference=insert-request:<id>`，锚点为原用户任务）；
3. 返回 `taskIdentifier`（此前恒 null）。

证据：`align02-runtime-insertion.test.ts`（concurrency=0 保持 pending 安全点）：
插入结果 `inserted`；mission 链与序列都出现该任务；同幂等键重复请求返回 `duplicate` 且序列只有一条。
公开全量 **605 files / 4206 tests** 通过。

**仍缺**：在途任务时的"推迟"路径端到端测试；推迟队列消费。

### 06 追加（2026-11-05）：推迟路径 + 又一个 revision 缺陷

**发现的真实缺陷**：终态回执把序列 revision 推进后，**控制器映射里的 revision 没有更新**
（实测序列 4、映射 2）⇒ 同一 mission 之后的运行中插入被误判 `stale-revision`。
修复：`syncSequenceTaskTerminalStatus` 迁移成功后同步 `missionTaskSequences` 的 revision。

**推迟路径测试**（`align02-runtime-insertion` 第二个用例）：
mission 已 done（组关闭）→ 插入返回 `deferred-to-sequence`；任务登记进权威序列，
并进入 `deferred-insertions.json` 的 pending 队列（`DeferredInsertionQueueStore.listPending` 验证）。
推迟队列消费方（组边界 `consumeDeferredInsertions`）已在代码中接线，但本轮未做跨组消费的端到端实测。

公开全量 **605 files / 4207 tests** 通过。

**仍缺**：跨组消费端到端；在途任务（有 running）导致的推迟（组关闭路径已测）。

### 03 追加（2026-11-05）：执行节点优先级进入 ready set

- `TaskDependencyNode` 增加可选 `priorityTier`；
- 本地规划契约把**模型规划的节点固定为 1（Agent 层）**，候选稿自带 `priorityTier` 仍被拒绝
  （`task-decomposition-priority`：规划=1、越权字段被拒、单节点降级保持用户层）；
- 派发消费者构造 ready set 节点时使用 `task.priorityTier ?? 0`（旧链/降级按用户层 0）；
- 公开全量 **606 files / 4210 tests** 通过。
- **仍缺**：任务链节点进入 `ready set` 后与用户层任务**同场排序**的真实场景（当前 mission 内全部同层）；
  任务包（bundle）仍是整包参与但无生产 `createTaskBundle` 调用。

### 02 追加（2026-11-05）：项目摘要注入 + 优先级落盘缺陷

- `ApplicationRuntimeOptions` 新增 `projectSummaryProvider`，并真正传给控制器
  （此前既不在运行时选项，也没传给控制器 ⇒ 规划器永远拿到 null）；
- 规划启用条件保持：`isModelTaskPlanningEnabled === true` **且** 存在 `workerRuntimeFactory`
  （默认关闭，不把未验证行为推给所有任务）；
- **发现的真实缺陷**：`taskDependencyNodeSchema` 未声明 `priorityTier` ⇒ zod 会把 03 新加的
  优先级**静默剥离**（测试先失败再修）；已加入可选字段（0–3）并随任务链落盘。
- 证据：`align02-project-summary-planning.test.ts`（规划=model、摘要提供者收到 projectIdentifier、
  节点 priorityTier=1）；公开全量 **607 files / 4211 tests** 通过。
- **仍缺**：真实模型规划验证（本轮用 scripted runtime 走同一契约）；真实项目摘要来源由宿主注入（公开核心不读项目文件）。

### 05 追加（2026-11-05）：运行中状态 + 迁移规则修正

**发现的规则缺陷**：`transitionTaskStatus` 对 done/cancelled 等只允许 `pending/blocked` 前态
⇒ 任何被标为 `running` 的任务**永远无法收口**。已把 `running` 加入非 pending 目标的允许前态。

- mission 启动时（`recordMissionRelation` 之后）把序列原始任务 CAS 迁移到 `running`；
  失败只流式告知，不阻断 mission；
- 证据：`task-sequence-controllers` 新增 "running → done" 用例（16/16）；
  `align02-terminal-status-sync` 新增 "mission 运行期间序列任务为 running"（0 并发，2/2）；
- 公开全量 **607 files / 4213 tests** 通过。

**仍缺**：running → cancelled/blocked 的端到端（规则已允许，取消路径未专门测试）。

### 06 追加（2026-11-05）：在途任务导致推迟 + 取消终态

用 `HangingRuntime`（只在取消时收口）让任务保持 running：

- 有 running 任务时插入 → `deferred-to-sequence`（保守策略：不把插入塞进已发出工具调用的组）；
- `cancelMission` 后：mission 进入 cancelled/blocked，序列原始任务**离开 running**（终态同步生效）；
- 证据：`align02-inflight-insertion.test.ts`；公开全量 **608 files / 4214 tests** 通过。

### 05 追加（2026-11-05）：原子领取/失败释放的循环级测试

新增 3 个用例（连续调度测试 14/14）：

1. 未注册端口 ⇒ `blockedReason=dispatch-handler-missing`，不领取、不派发；
2. `claimTask` 返回 false ⇒ 跳过并写明"领取失败"；改为 true 后**可再次领取并派发**；
3. 派发被拒 ⇒ `releaseTask` 收到 `dispatch-rejected`；派发抛错 ⇒ 释放并记录 `dispatch-error`。

公开全量 **608 files / 4217 tests** 通过。

**仍缺**：与真实编排器组合的"领取→失败→释放→再领取"（本轮是端口级，不是 MissionOrchestrator 级）。

### 06 追加（2026-11-05）：推迟队列消费入口与幂等

- 新增公开入口 `MainController.consumeDeferredInsertionsForMission(missionId)`；
  生产调用方仍是**同一 mission 下一组**的组边界端口（`taskGroupBoundaryPort`），
  公开入口用于运维/测试在边界外驱动同一逻辑（**消费 ≠ 派发**，不改图、不启动任务）。
- 测试扩展（`align02-runtime-insertion` 推迟用例）：消费后 `listPending` 为空、
  `consumed` 含该任务、重复消费保持空（幂等）。
- 公开全量 **608 files / 4217 tests** 通过。
- **仍缺**：真实"下一组"自动触发（goal 多组/恢复组）的端到端。

### 03 追加（2026-11-05）：ready set 选择的直接测试

新增 `ready-task-group-selection.test.ts`（5/5）：

1. 依赖未满足的任务**永不入选**（即使层级更高）；
2. 用户层（0）排在 Agent 层（1）前；必要前驱经 `min(自身, 后继)` 提升；
3. 包内存在非 pending ⇒ 整包推迟（`deferredReasons` 说明）；
4. 预算按单元计：包算 1 个单元、**不截断包内任务**；
5. `maximumUnitCount=0` 拒绝，不静默按 1 处理。

公开全量 **609 files / 4222 tests** 通过。

**仍缺**：`createTaskBundle` 生产调用；选择结果与真实派发在同一次任务组中的组合（当前是纯函数证据）。

### 07 追加（2026-11-05）：停止与等待联动

- 运行时 `shutdown` 现在调用 `secondaryDispatchLoop.stop()`（幂等），
  使所有等待者立即被唤醒（`stop()` → `wake("external")`）；
- 测试：`stop()` 立即唤醒 `waitForNextWake`（<1s）；停止后 `runRound` 返回
  `blockedReason="loop-stopped"`；runtime.shutdown 后同样为 `loop-stopped`。
- 公开全量 **609 files / 4223 tests** 通过。
- **仍缺**：真实时钟驱动的退避（测试使用短等待）与外部取消信号直接注入循环。

### 06 追加（2026-11-05）：推迟登记并发写同一序列

负载下暴露：mission 刚 done、终态回执同步仍在写序列时，推迟插入的
"读 revision → insert" 会被抢先 ⇒ `stale-revision` 直接把用户请求打回。
修复：推迟登记遇 `stale-revision` **有界重试 3 次**（20ms 间隔），仍失败才如实报错；
测试先等 revision 稳定再发起请求。公开全量 **611 files / 4233 tests** 通过。

### 03 收口（2026-11-08）：调度器真正按有效优先级 + 声明序

**发现的真实缺陷**：`TaskGraph.findRunnableTaskIds()` 用裸字典序 `sort()` ——
`priorityTier` 完全不参与、同层顺序是 `a-` 压过先声明的 `z-`。这与卡内
"用户层最高、同层稳定排序"直接冲突，且 `ready-task-group-selection.ts` 里
已实现的有效优先级**从未被调度器消费**（两套排序口径）。

**修复**（`packages/core/src/core/task-graph.ts`）：

| 要点 | 实现 |
|---|---|
| 有效优先级 | `computeEffectivePriorityTiers()`：`min(自身 tier, 所有可达后继 tier)`，记忆化 DFS，占位防自旋 |
| 同层稳定 | 新增 `declarationOrderById`：按**声明位置**（构造与追加时递增），不是字典序 |
| 确定性 | 最终以 `taskId.localeCompare` 决平 —— 同输入永远同顺序 |
| 准入不变 | 仍只取"pending 且依赖全 done"；置顶/提权/声明序只在集合**内部**排序 |

**证据**：`tests/core/unit/dag-scheduler-ready-order.test.ts` 5/5：
tier 0 先于 tier 1（字典序相反）、同层先声明先执行、
紧急后继把闸门任务提权（未就绪后继不启动）、
未满足依赖永不被绕过（先满足依赖，完成后才启动后继）、重复构造顺序一致。
公开全量 **625 files / 4303 tests** 通过。

**仍未做（如实）**：任务包（bundle）单元选择仍由 `selectNextTaskGroup` 提供，
调度器按任务而非包派发；`maximumUnitCount` 预算未进入 `scheduleRound`。
本检查点标 **implemented-unverified**（未经真实 mission 端到端观察）。

### 05 收口（2026-11-08）：生产上真的领取与释放

**发现的真实缺陷**：`createMissionDispatchPorts` 只包装了 `dispatchTaskByTaskIdentifier`，
**没有提供** `claimTask` / `releaseTask`。于是调度循环里那段"领取失败 ⇒ 跳过 /
派发被拒 ⇒ 释放"的代码**只在测试里被人工注入过**，生产路径上从不发生：

- 序列里的原始用户任务会停在 `pending`，没有任何"领取 → 失败 → 释放 → 再领取"闭环；
- `claimTask` 的 double-claim 保护在生产里也从未被调用。

**修复**：

| 要点 | 位置 | 说明 |
|---|---|---|
| 端口工厂扩展 | `secondary-continuous-dispatch-loop.ts` `createMissionDispatchPorts` | 接受并透传 `claimTask` / `releaseTask`（缺省不伪造 `true`） |
| 生产装配 | `main-controller.ts` `registerMissionDispatchConsumer` | 注入真实领取/释放 |
| 只领取原始任务 | `claimSequenceTaskForMission` | mission 链的其他节点没有序列条目，领取它们会永久跳过（会丢任务）⇒ 只领取 `mapping.taskIdentifier` |
| revision 同步 | `syncMissionSequenceRevision` | 领取/释放后同步映射 revision，避免后续插入被误判 `stale-revision` |
| 释放失败可见 | `releaseSequenceTaskClaimForMission` | 只写诊断，不掩盖原始派发失败原因 |

**顺带修复的真实缺陷**：`registerMissionArtifacts` 在 mission 目录已被清理时会抛
`mission-not-found`，而调用方是 `void` ⇒ **未处理的 Promise 拒绝**，实测让整轮门禁报错
（即使任务本身正常收口）。现改为容忍缺失直接返回。

**证据**：
- `dispatch-claim-production` 3/3：端口透传、领取真的把序列任务置 running、
  派发被拒后回到 pending 且占用回落、重复领取只成功一次；
- `dispatch-claim-real-mission` 2/2：真实 mission 跑完后序列原始任务不再是 `pending`；
  无序列映射的 mission 行为不变。
公开全量 **629 files / 4318 tests** 通过。

**仍未做（如实）**：租约过期接管（`takeOverExpiredLease`）与本闭环的联动未验证；
"领取 → 执行者崩溃 → 租约过期 → 另一进程接管"没有端到端实测。
本检查点标 **implemented-unverified**。

### 07 收口（2026-11-08）：退避与唤醒按真实时钟验证

**此前边界**（卡内如实记录）："退避未与真实时钟/取消联动"——只在测试里断言过
`recommendedWaitMilliseconds` 的**数值**，没验证循环真的按该值等待、且等待可被打断。

**本轮证据**（`tests/core/unit/dispatch-backoff-clock.test.ts` 5/5）：

| 断言 | 结果 |
|---|---|
| 无工作 ⇒ 空闲等待 30s（不忙轮询） | 通过 |
| 有进展 ⇒ 1s；连续无进展 ⇒ 指数退避并封顶 30s | 通过 |
| `notifySchedulingEvent` 立即打断等待（< 1s），且原因如实回报事件名 | 通过（发现并修正：原因返回的是 `task-finished` 而非笼统 `event`） |
| `stop()` 后等待立即返回（不卡退出） | 通过 |
| 同一任务连续失败达上限 ⇒ 停止自动重派；`resetDispatchFailureCounts()` 后可重试 | 通过（实测调用次数正好 3 次） |

公开全量 **630 files / 4323 tests** 通过。

**仍未做（如实）**：退避未与**真实生产循环**的 wall-clock 计时对照（只在单元层验证）；
"失败 → 退避 → 状态变化 → 重派"的端到端时序未实测。本检查点标 **implemented-unverified**。

### 05 补充（2026-11-08）：租约隔离不误派发

卡内归还的边界："租约过期接管与本闭环的联动未验证"。本轮先钉住租约本身的行为
（`tests/core/integration/lease-isolation-dispatch.test.ts` 6/6）：

| 断言 | 结果 |
|---|---|
| 同 mission 二次申请 ⇒ `locked-active`，属主不被覆盖 | 通过 |
| 同进程重入 ⇒ `acquired-reentrant`（恢复/重试不被自己挡住） | 通过 |
| 活跃租约禁止接管（`租约仍活跃`） | 通过 |
| 过期后用正确 revision 接管，`leaseRevision` 1 → 2、属主换人 | 通过 |
| 接管 revision 不匹配 ⇒ `stale-revision` | 通过 |
| 不存在租约不可接管；非属主续约被拒 | 通过 |

公开全量 **631 files / 4329 tests** 通过。

**仍未做（如实）**：没有跑"进程 A 持租约 → 进程 A 崩溃 → 进程 B 接管 → B 继续领取任务"
的**跨进程**端到端；租约接管与序列 claim 的联动（B 接管后能否安全 claim 同一任务）仍未实测。

### 05 补充二（2026-11-08）：崩溃遗留领取的核对已接线

**发现的真实缺陷**：`claimTask` 只接受 `pending`。进程 A 领取（→`running`）后崩溃 ⇒
租约过期、进程 B 接管并恢复，但序列任务**仍停在 running** ⇒ B 永远领不到，
派发循环每轮都以"领取失败"跳过，**任务被静默搁死**。

**修复**：

| 要点 | 位置 | 说明 |
|---|---|---|
| 核对入口 | `main-controller.ts` `reconcileStaleSequenceClaim` | 把该 mission 的原始序列任务从 `running` **受控释放**回 `pending` |
| 顺序 | `resumeMission` | 在 `prepareResumeLease`（已成功接管租约）**之后**才核对；接管前别的进程可能仍在跑，提前释放会把它的在途任务打回 pending |
| 不倒退 | 复用 `releaseClaim` | `done`/`blocked` 不是 `running` ⇒ 释放被拒，终态不会退回待执行 |
| 无映射 | 同上 | 未建立序列映射 ⇒ 什么都不做，旧路径行为不变 |

**证据**：
- `stale-claim-recovery` 3/3：现场复现（crash 后停在 running 且领不到）、
  释放后重新领取成功、已完成任务不被释放成 pending；
- `resume-stale-claim-guard` 1/1：已完成任务再 resume 时序列状态保持不变（核对不与恢复门禁打架）。
公开全量 **633 files / 4333 tests** 通过。

**仍未做（如实）**：**跨进程**端到端（A 崩溃 → B 接管 → B 领取并执行）未实测；
仍然是单进程内用序列状态模拟崩溃现场。

### 05 补充三（2026-11-08）：跨进程租约隔离已实测

**此前边界**："没有跑'进程 A 持租约 → A 崩溃 → 进程 B 接管'的跨进程端到端"。

**本轮补齐**（真实起子进程，跑的是**构建产物**而不是源码）：

| 断言 | 结果 |
|---|---|
| 子进程持有租约 ⇒ 父进程 `tryAcquire` 返回 `locked-active`，属主仍是子进程 | 通过 |
| 子进程被 SIGKILL 后、其短 TTL 过期 ⇒ 父进程 `takeOverExpiredLease` 成功，属主换成父进程，`leaseRevision` 1 → 2 | 通过 |
| 子进程写入的租约对父进程**可见**（同一份磁盘状态，不是内存假象），revision 为 1 | 通过 |
| 子进程已退出但租约未过期 ⇒ 父进程仍被拒（不为"进程没了"就误派发） | 通过 |

夹具：`tests/fixtures/mission-lease-child-fixture.mjs`（按前缀发现构建产物文件名，
不写死内容哈希；`ASTARRAY_FIXTURE_LEASE_TTL_MILLISECONDS` 可注入短 TTL）。

顺带遵守既有架构守卫：本文件起了子进程 ⇒ 显式 `vi.setConfig({ testTimeout: 60_000 })`
（`subprocess-test-timeout-budget` 守卫当场报红，已修复）。

公开全量 **634 files / 4336 tests** 通过。

**仍未做（如实）**：跨进程的**序列领取**闭环（B 接管租约后 claim 同一序列任务）仍未实测；
本轮只覆盖租约本身。
