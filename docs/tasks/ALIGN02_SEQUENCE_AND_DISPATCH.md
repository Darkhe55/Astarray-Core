# ALIGN-02：统一偏序集、任务组和次级持续调度

日期：2026-10-27。状态：in_progress（01 已交付；02 部分交付；均 implemented-unverified；2026-10-28）。

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
