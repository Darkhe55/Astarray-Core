# ALIGN-03：下级执行、次级审查集成与报告闭环

日期：2026-10-27。状态：**in_progress（01–07 部分交付）**；其中 **01 独立验收闭环已编码完成并验证**（implemented-unverified，2026-11-11；默认开关保持关闭、不归档）。

执行约定：只修改本卡负责范围；先备份覆盖前文件，保留并行工作。每轮一个编号步骤，超过 3 小时拆分剩余步骤继续。允许更新本卡与所属仓库索引，不授权安装依赖、提交推送或调用真实付费模型。本轮沿用用户要求，不编写/运行测试，不构建或人工验收；按源码调用链交付证据，完成只能标 implemented-unverified，不得宣称运行验证通过。既有测试和 CI 不删除、不弱化。发现相关实现已存在则复用，不重复造轮子；缺少可信授权或遇并行覆盖冲突只阻塞对应步骤。具体模型是否曾替换设计无可靠证据，不作来源归罪。

前置：ALIGN-02。复用 worker、Git 集成、生命周期、反馈、工具说明与个体档案；不另建 Agent 框架。
## 固定实现
1. 次级任命执行与测试/审查的具体下级；同一执行任务的自报不能代替独立审查结论。执行者只完成被分配任务链并向唯一直属上级报告，已有受控四级委派规则不变。
2. 持续调度的任务包携带工具权限上限、项目边界、原始要求、完成条件和选择性附件；子权限与上级有效权限求交。工具首次说明/后续回访复用已有协议，不能每次重发完整工具库，也不能在缺用法时让模型猜。
3. 真实工具结果、产物记录和明确完成标识进入本地完成门禁。失败/中断只报告原因，不伪造 done；早停从已登记检查点有界续跑，不拿下一组任务掩盖未完成组。
4. 涉及 Git 的任务由次级创建隔离工作区/分支、指定审查者、判定返修或合并。三级只提交自己的分支，不直接合入目标分支；人工并行修改不覆盖，不自动 stash/reset 用户工作。
5. 审查结果绑定任务、来源个体、产物 revision/commit、证据和结论。过期或不匹配证据不能合并；人工验收策略按现有协同/放权配置，不凭本卡改变批准权。
6. 反馈保留独立进程生产路径、来源个体与目标标识；消息幂等入库，传输失败可补送。次级向主 Agent 报告摘要引用，主侧归档，不自动注入所有明细。
7. 三级成功/中断/上下文过长后的关闭与接手复用生命周期控制器，先保存个体档案再释放进程。移交只附选定档案，不合并兄弟记忆。Git 远端失败是本地保全待同步，不把本地成功写成推送成功。
## 交付与关闭条件
从生产派发到产物/审查/集成/报告/回收均有消费者，不能只有可单独调用的组件。读写权限、敏感内容本地拒绝、备份、上下文节点关闭及原文回访保持原设计。
本卡不要求实际运行测试，但必须接入产品的测试/审查 Agent 职责与证据处理能力，两者不是同一概念。


## 检查点记录

### 01 独立审查：直属上级 + 非自报证据——**部分交付**（2026-10-28）

**审查发现**：`AgentAppointmentRegistry`（作者不得自验）与 `AcceptanceVerdictGate`
（裁决绑 revision/提交哈希、高风险需人工）都已完备，但**只被 CLI 合成场景
`StandaloneWorkflowRunner` 使用**；真实任务完成路径既不任命也不裁决。另有两处缺口：
任命不校验验收者的**直属上级**（可借别家次级的人签字）；裁决只要求证据数组非空，
**执行者自报**就能当唯一证据。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 门禁 | `packages/core/src/orchestration/independent-review-gate.ts` | 任命/裁决/合并评估三层封装 |
| 直属上级 | 同上 `appoint` | 验收者必须是已登记三级、mission 一致、`owningSecondaryAgentInstanceId == 任命次级`；任命者不得自审 |
| 非自报证据 | 同上 `recordVerdict` | 证据全为 `self-report:`/`executor-report:`/`agent-claim:` 前缀或为空 ⇒ 拒绝；理由必填 |
| 纵深防御 | 同上 | 裁决者等于实现/测试者 ⇒ 拒绝（即使任命被绕过） |
| 入口 | `main-controller.ts` `appointExecutionAndReview` / `recordAcceptanceVerdict` / `evaluateTaskMergeReadiness` | 本地控制面（非模型工具） |
| 只读查询 | `RegisteredAgentDirectory.getAgentEntry` | 直属上级校验所需 |

**未做（如实）**：**编排未强制** —— 任务 `done` 的完成门禁没有要求"存在独立验收裁决"，
不任命/不裁决仍可能被判完成（属 03-02/03-03）；三个入口无自动调用方；四级委派规则未改；
证据前缀是约定而非封闭集合；未跑任何一条拒绝/通过路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 02 任务包派发信包（权限求交/边界/工具说明引用）——**部分交付**（2026-10-28）

**审查发现**：`TaskBundleRecord` 只有 `bundleId/boundAgentInstanceId/sequenceRevision/taskIds/status`，
卡内点名的六项（工具权限上限、项目边界、原始要求、完成条件、选择性附件、工具说明引用）**全无**；
`createTaskBundle` 不接收权限上限/边界；工具说明协议（initial-full / reminder / delta）虽已完备，
但任务包与它**没有任何引用关系**。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 信包构造 | `packages/core/src/orchestration/task-bundle-dispatch-envelope.ts` | 严格白名单；禁止 `toolDescriptors/availableTools/toolLibrary/fullDocumentation/toolSchemas`；六项校验；附件必须 `attachmentIdentifier + contentHash` |
| 权限求交 | 同文件 `intersectToolPermissionCeiling` | `allowed = 请求 ∩ 上级`；超出项进 `deniedToolNames` 如实上报；求交为空即拒绝 |
| 持久化 | `core/types.ts` + `core/schemas.ts` + `task-bundle-planner.ts` + `task-sequence-controllers.ts` | `TaskBundleRecord.dispatchEnvelope`（可选、schema 校验、随包落盘） |
| 读取 | `TaskSequenceStatusController.getSnapshot().bundles` | 信包随包返回（已含） |

**未做（如实）**：**执行侧不消费**（orchestrator/worker 派发仍用原工具端口与提示词，
信包停在数据层）；`createTaskBundle` 仍无生产调用方；`deniedToolNames` 只上报不升级；
工具说明协议未改动（只引用 revision）；未跑求交/禁止字段/六项缺失任何一条路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 03 完成收据与编排层完成门禁——**部分交付**（2026-10-28）

**审查发现**：`LocalCompletionVerifier`（八条本地条件）**零调用方**，从未在生产路径执行；
Worker 自己检查完成事件/写工具/产物，但**编排层只看到 `outcome: "success"` 就 `finishTask(done)`**，
中间没有任何可核对的收据跨边界传递。G5 早停续跑（≤2 次）与"失败只报原因"已存在，本轮未改。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 收据契约 | `packages/core/src/orchestration/completion-receipt.ts` | 字段全部取自本地真实状态（完成事件是否校验、工具调用数、落盘产物路径）；缺失即不足、不补默认收据；矛盾（要求事件却未声明/空产物路径/计数非法）即不足 |
| 收据生成 | `worker-agent.ts` 成功分支 | `outcome.success.completionReceipt` |
| 编排门禁 | `mission-orchestrator.ts` success 分支 | `isCompletionReceiptRequired` 开启且收据不足 ⇒ **blocked + 升级**，不判 done |
| 开关透传 | `main-controller.ts` + `application-runtime.ts` | 缺省 **false**（未实测的收口变更不默认推送） |

**未做（如实）**：默认关闭（生产仍"success 即 done"）；**`LocalCompletionVerifier` 仍未调用**
（需把解析后的 `TaskCompletionEventV1` 从 Worker 传到编排层，是 03-03 后半）；
收据不含权限待决/反馈未确认/revision/活锁预算；未接产物验收门禁；未跑任何一条路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 04 Git 集成：审查者独立 + 干净工作区守卫——**部分交付**（2026-10-28）

**审查发现**：隔离 worktree/分支、贡献验证、返修判定、目标分支五门禁都已存在；
但 ①`GitContributionReviewRecord` **没有审查者字段**（无法表达/强制"作者不能自审"）；
②`submitContribution` 与 `finalizeIntegration` 都在**共享仓库**里 `checkout` + `merge`，
**没有检查工作区是否干净** —— 人工未提交改动会被携带/覆盖。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 审查者字段 | `core/types.ts` `GitContributionReviewRecord.reviewingAgentInstanceIdentifier?` | 缺省 `null` = 未指定，**不得当作已审查** |
| 作者不能自审 | `submitContribution` | 审查者 == 贡献者 ⇒ `task-sequence-permission-denied` |
| 提交侧守卫 | 同上 | `status --porcelain --untracked-files=no` 非空 ⇒ 抛 `stale-human-change`，**拒绝** checkout/merge，明确"不 stash/reset/checkout 丢弃" |
| 收尾侧守卫 | `finalizeIntegration` | 目标分支合并前同样检查；脏 ⇒ 写 `unresolvedRisks` 并**不合入**（返回而非抛） |
| `reset --hard` 边界 | `git-recovery-point-service.ts`（未改） | 仅存在于显式恢复点恢复，且恢复前自动建前置恢复点 |

**未做（如实）**：审查者未做**注册/隶属**校验（协调器无注册目录端口）；没有"指定审查者"的
分配入口；目标分支合并仍恒不可用（人工体验/授权无来源）；人工改动判定只有"干净/脏"，
未按路径联动 `human-worktree-observer`；未跑任何一条守卫路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 05 合并前审查证据绑定校验——**部分交付**（2026-10-28）

**审查发现**：`GitContributionReviewRecord` 已记 `taskId/baseCommit/headCommit/changedPaths/
reviewDecision/executedChecks`（本轮又加审查者），但 `finalizeIntegration` **从不回看**这些字段：
只要报告有 `integrationCommit` 就继续跑测试并可能合入目标分支 ⇒ "审的是 A 版本、合并的是 B 版本"
这种**过期证据拦不住**。（`AcceptanceVerdictGate` 的 revision/commit 失效是另一条链路，未统一。）

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 证据判定 | `packages/core/src/orchestration/git-review-evidence.ts` | 结论必须 accepted；任务绑定一致；base/head 非空且不同；**headCommit 必须在集成分支历史中**；要求审查者时必须存在且 ≠ 贡献者 |
| 合并前核对 | `git-integration-coordinator.ts` `finalizeIntegration` | 逐条 accepted 贡献探测 `merge-base --is-ancestor`；不匹配 ⇒ 写 `unresolvedRisks` + **直接返回（不合入）** |
| 只读探测 | 同文件 `isCommitInBranchHistory` | 非零退出 ⇒ false（不把探测失败当通过） |
| 批准权不变 | — | 人工体验/授权仍由既有五门禁与用户配置决定，本卡只校验证据匹配 |

**未做（如实）**：审查者要求**默认关闭**（旧报告/测试无该字段，默认强制会让历史集成立刻不可收尾，
需产品决策）；只绑 commit，未绑序列 revision/证据哈希，也未校验 `changedPaths` 与当前 diff 一致；
与 `AcceptanceVerdictGate` 仍是两条独立证据链；未跑任何一条拒绝/通过路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 06 反馈幂等入库与本地补送——**部分交付**（2026-10-28）

**审查发现**：独立进程路径已存在（supervisor fork + IPC + 子进程 MailboxJournal/DeliveryWorker）。
两处缺口：①`MailboxJournal.enqueue` **不按 `idempotencyKey` 去重** ⇒ 重发会入库/投递两次；
②客户端 `enqueue` 只在内存发一次，子进程崩溃/超时即拒绝 ⇒ **消息丢失**（journal 只覆盖已入库后的重放）。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 客户端 outbox | `feedback-process/transport.ts` | **先原子落盘**（`<state>/feedback-client-outbox/<sha256(key)>.json`）→ 发 IPC → ack 后删除；失败保留文件 |
| 补送 | 同文件 `flushPendingOutbox` | 逐条重发、单条失败不影响其余；损坏文件**保留不删**、不计成功 |
| 补送触发 | `process-supervisor.ts` 心跳 | 每次心跳顺带 `flushPendingOutbox()`（失败不抛、不影响心跳） |
| 幂等入库 | `feedback-process/mailbox-journal.ts` | 同键同内容 ⇒ 返回既有序列号不追加；同键异内容 ⇒ `operation-not-idempotent`；比较口径排除 messageId/createdAtIso |
| 摘要引用/不自动注入 | — | ALIGN-01-06 已实现（索引只读、prompt 装配无报告引用），本轮未改 |

**未做（如实）**：补送**无上限/无退避**（每次心跳重试，可能长期占用 IPC）；积压条数无可观测消费；
损坏 outbox 文件无清理策略；未跑"失败→保留→补送→只入库一次""同键异内容→拒绝"任何一条，
也未做子进程崩溃恢复实测。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 07 三级收口：真实生命周期钩子——**部分交付**（2026-10-28）

**审查发现**：`TertiaryAgentLifecycleController` 在生产装配里是**空 hooks** 构造；
`runPhase` 在 hook 缺失时记为 `none` 并继续 ⇒ 收口"看起来成功"但**没存档案、没写移交、
没处理 Git 资源**。且 hook 不带个体标识、控制器是共享实例 ⇒ 接线方只能猜"关的是谁"。
另：`shutdown()` 在生产代码**没有任何调用方**（只有 getter 暴露）。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| hook 带上个体 | `tertiary-lifecycle.ts` | 每个 hook 收到 `agentInstanceId`（无参写法仍兼容） |
| 真实钩子 | `packages/core/src/orchestration/tertiary-lifecycle-hooks.ts` | 检查点读**自己的**档案 revision（无档案 ⇒ `no-archive`；损坏照常抛错）；移交文件只含**选定**附件哈希 + `doesMergeSiblingMemory:false`；Git 资源如实报 `no-git-allocation`；其余阶段返回明确 `no-*`/`in-process-worker` |
| 装配 | `application-runtime.ts` | 先建记忆存储 → 构造 hooks → 再用 hooks 构造控制器 |

**未做（如实）**：**没有生产调用方驱动 `shutdown()`**（Worker 是进程内异步任务，编排层不调控制器）；
Git 资源端口未装配（恒 `no-git-allocation`）；移交文件**读入/接手**未实现；未跑过任何一次真实收口。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 06 补送退避（2026-11-09 追加）

**缺口（本卡 2026-10-28 记录）**：补送"**无上限/无退避**"——每次心跳重试全部积压条目，
子进程长期不可用时每个心跳都要走一遍 IPC 超时，可能长期占用通道。

**修复**（`packages/core/src/feedback-process/transport.ts`）：

| 要点 | 实现 |
|---|---|
| 指数退避 | 失败后按次数等待 1s→2s→4s…（上限 60s），窗口内本轮不尝试 |
| **不设重试上限** | 退避只降低频率；消息**不得被静默丢弃** |
| 积压可观测 | `flushPendingOutbox()` 新增 `deferredCount`（因退避未尝试的条数），与既有 `remainingCount` 一并返回 |
| 成功后清状态 | 发送成功即删除该文件的退避记录 |

**证据**（`align03-outbox-backoff` 4/4）：指数序列 1/2/4/8s；饱和于 60s；
饱和后**仍是有限等待**而非放弃；退化输入（0/负数）按第 1 次处理。

**仍未做（如实）**：**未**验证"心跳触发退避"的端到端行为（需要可注入的子进程传输层，
当前 `ForkFeedbackClient` 构造依赖真实 `ChildProcess`）；子进程崩溃恢复实测仍未做。

### 05 证据绑定：通过/拒绝路径已跑（2026-11-09 追加）

**缺口（本卡 2026-10-28 记录）**："**未跑任何一条拒绝/通过路径**"。

**本轮**：为纯判定函数 `evaluateContributionReviewEvidence` / `assertContributionReviewEvidence`
补 11 条测试，覆盖卡内点名的每条语义：

| 用例 | 期望 |
|---|---|
| 合法证据 | 放行，`reasons` 为空 |
| **headCommit 不在集成分支历史** | 拒绝，原因含"过期"（本卡核心反例） |
| 结论非 accepted | 拒绝，带出驳回原因 |
| 任务绑定不一致 | 拒绝 |
| base/head 为空 / 两者相同 | 拒绝 |
| 要求审查者但未指定 | 拒绝（未指定 ≠ 已审查） |
| 审查者 == 贡献者 | 拒绝（作者不能自审） |
| 不要求审查者 + 无审查者 | 放行（旧报告兼容） |
| 多条不合格 | **全部**列出，不只第一条 |
| 断言版错误码 | 过期 ⇒ `stale-revision`；其它 ⇒ 权限码 |

公开全量 **666 files / 4535 passed + 3 skipped**。

**仍未做（如实）**：审查者要求**默认关闭**（需产品决策）；只绑 commit、未绑序列 revision/证据哈希；
未校验 `changedPaths` 与实际 diff 一致；与 `AcceptanceVerdictGate` 仍是两条独立证据链。

### 04 审查者登记校验（2026-11-09 追加）

**缺口（本卡记录）**：协调器只校验"审查者 ≠ 贡献者"，**不校验审查者是否真实存在**
⇒ 任意字符串（含拼写错误、已回收个体）都能当审查结论来源。

**交付**：

| 要点 | 位置 | 说明 |
|---|---|---|
| 纯判定 | `git-integration-coordinator.ts` `assertReviewerIsRegistered` | 已装配登记目录时，审查者必须在目录中；未装配 ⇒ **不做**存在性校验（不假装已校验） |
| 装配点 | 同文件 `options.agentDirectory` | 可选端口；缺省保持原行为 |

**证据**（`align03-review-evidence` 15/15，新增 4 条）：已登记 ⇒ 放行；**未登记 ⇒ 拒绝**；
未指定审查者 ⇒ 不校验；未装配目录 ⇒ 不校验（不假装）。

**仍未做（如实）**：**隶属校验**（审查者是否属于同一/授权的次级）未做 ——
`GitWorkerAllocation` 只有 `tertiaryAgentInstanceId`，没有 owning secondary，需先补数据；
`agentDirectory` 也尚未从运行时装配进协调器（当前默认未传）。

### 04 审查者目录装配（2026-11-09 追加）

**缺口**：`assertReviewerIsRegistered` 已实现，但协调器**没有拿到登记目录**
⇒ 生产里永远走"未装配 ⇒ 不校验"，等于死代码。

**修复**：`application-runtime.ts` 构造 `GitIntegrationCoordinator` 时传入
`agentDirectory: registeredAgentDirectory`（运行时已有同一实例，不新建第二份）。

**验证**：`git-coordinator-branches` / `git-defensive-branches` / `e2e01-vertical-integration-report`
共 16 条全通过（现有协调器路径未受新端口影响）；公开全量 **666 files / 4539 passed**。

**仍未做（如实）**：**隶属校验**（审查者是否属于授权的次级）仍未做 ——
`GitWorkerAllocation` 无 owning secondary 字段，需先补数据；本条只保证"审查者真实存在"。

### 04 审查者隶属校验（2026-11-09 追加）

**缺口（本卡记录）**："任命不校验验收者的**直属上级**（可借别家次级的人签字）"。

**实现**：`assertReviewerIsRegistered` 扩展为同时做**隶属**校验 ——
从登记目录读审查者与贡献者的 `owningSecondaryAgentInstanceId`，
**两者都可得且不同** ⇒ 拒绝（跨次级签字）；任一侧缺数据 ⇒ 不猜测、不拒绝，也**不假装已校验**。

**为什么不需要改 `GitWorkerAllocation` 结构**：所属次级本来就在登记目录里，
校验时按个体 ID 查即可；不必把数据复制进分配记录（少一处可能失同步的副本）。

**证据**（`align03-review-evidence` 19/19，新增 4 条）：同一所属次级 ⇒ 放行；
**属别的次级 ⇒ 拒绝**（原因含"跨次级"）；任一侧缺所属次级 ⇒ 不拒绝；
未给贡献者 ⇒ 只做存在性校验。

公开全量 **666 files / 4543 passed + 3 skipped**。

**仍未做（如实）**：`owningSecondaryAgentInstanceId` 在实际三级登记时是否**总是**被填 ——
若生产登记路径漏填，隶属校验会静默退化为"不校验"。需要单独核对登记入口。

### 04 隶属校验的生效条件核对（2026-11-09，**只核对，未改代码**）

上一轮实现了"审查者必须与贡献者同一所属次级"。本轮核对它**在生产里是否真的生效**，结论是：**默认不生效**。

**核对结果**（`git grep '\.registerAgent('`）：

| 登记点 | 角色 | `owningSecondaryAgentInstanceId` |
|---|---|---|
| `application-runtime.ts:2322`（`registerAgentInstance`，控制面 API） | 调用方指定 | 调用方指定 |
| `main-controller.ts:3881`（`registerAgent`，控制面 API） | 调用方指定 | 调用方指定 |
| `main-controller.ts:3993`（自动登记） | `secondary` | **`null`** |

**关键事实**：编排层**不会自动登记 Worker（三级）**。`DagScheduler.allocateAgentId` 产出
`worker:<mission>:<task>`，但没有任何路径把它写进登记目录。

因此生产默认状态下：

- `contributorEntry` 为 `null` ⇒ `contributorOwningSecondary` 为 `null` ⇒ **隶属校验静默跳过**；
- 审查者若不主动登记，**存在性校验也会拒绝**（这一条倒是真的会拦）。

**这不是缺陷，是概念缺口**：`worker:<mission>:<task>` 由调度器直接派发，**没有"所属次级"**；
"隶属"只对**四级委派**（次级 → 三级）那条路径成立（`secondary-continuous-dispatch-loop` +
`UnboundedAgentInstanceRegistry`），那条路径目前也没把个体写进登记目录。

**结论**：隶属校验当前对"调度器派发的 Worker"恒不触发。要让它生效，必须先决定
**这些 Worker 的"所属次级"是谁**（main agent？发起该 mission 的次级？还是引入"mission 所有者"概念），
属产品/架构决策，**不在本卡擅自决定**。

**本卡据此保持 implemented-unverified**，并在下文列出待决策项。

### 01 剩余项与 04 隶属校验**同一阻塞**（2026-11-10 核对）

**01 剩余缺口**："真实任务完成路径既不任命也不裁决"。

**核对**：`appointExecutionAndReview` / `recordAcceptanceVerdict` 已由 `application-runtime`
暴露为控制面 API（`:2359`、`:2373`），但**没有**任何路径在任务完成时自动任命审查者。

**为什么这不是"再写一段接线"就能解决的**：

自动任命必须回答"**谁**是这条任务的审查者"——而审查者必须
①已登记、②与贡献者**同一所属次级**（04 已实现）。但调度器派发的 Worker
（`worker:<mission>:<task>`）**没有所属次级**（见 04 的核对结论）。

⇒ **01 的自动任命与 04 的隶属校验，卡在同一个未决问题**：
调度器派发的 Worker 的"所属次级"是什么（main agent / 发起次级 / 引入 mission owner）。

**一旦该问题有答案**，两处可一并完成：
① 在 Worker 登记时写入 `owningSecondaryAgentInstanceId`；
② 任务完成时按同一所属次级自动任命审查者并等待裁决。

**因此 01 记为"等待同一产品决策"**，不重复计为两个独立阻塞。

### 02 信包白名单/六项校验/权限求交已跑（2026-11-10 追加）

**缺口（本卡记录）**："未跑求交/禁止字段/六项缺失任何一条路径"。

**本轮**：`align03-task-bundle-envelope` **10 条**：

| 用例 | 期望 |
|---|---|
| 合法信包 | 构造成功，六项齐备 |
| **五个禁止字段**（`toolDescriptors`/`availableTools`/`toolLibrary`/`fullDocumentation`/`toolSchemas`） | 逐一拒绝（不静默忽略） |
| 未知字段 | 拒绝（白名单外不静默忽略） |
| **权限求交** | 超出上级进 `deniedToolNames`，不进 `allowedToolNames` |
| 求交为空 | 拒绝（不发空权限信包） |
| **必需项**缺失（五项） | 逐一拒绝 |
| `selectedAttachments` 缺省 | **允许**，默认空数组 |
| 附件缺 `contentHash` | 拒绝 |
| 非对象信包 | 拒绝 |
| `intersectToolPermissionCeiling` | 去重并保留顺序 |

**一处实测更正**：卡内写"六项校验"，但 `selectedAttachments` 实际是**唯一可选**项
（缺省空数组，不拒绝）。已在用例中明确钉住，避免以后按"六项都必需"去改坏它。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **674/675 files、4595 passed**，
唯一失败是既有的 `public-sdk` 类抖动家族新增一员 `obs01-diag-production-collection`（隔离 5/5 通过），
与本次改动无关。

**仍未做（如实）**：**执行侧仍不消费信包**（orchestrator/worker 派发仍用原工具端口与提示词）；
`createTaskBundle` 仍无生产调用方；`deniedToolNames` 只上报不升级。

### 02 执行侧消费**前置条件未满足**（2026-11-10 核对）

**核对**：全仓 `createTaskBundle` **只有一个定义、零调用方**
（`task-sequence-controllers.ts:483`）。

⇒ 生产里**根本不存在**任务包，执行侧（Worker 派发的 `task.toolNames`）自然无从消费。

**这意味着"把信包接进执行侧"当前是伪任务**：即使把派发改成
「有信包用 `envelope.allowedToolNames`，否则回退 `task.toolNames`」，
回退分支会 **100% 命中**，改动不改变任何行为，只是又一处"看起来接好了"的假接线。

**真正的先后关系**：

1. 规划/派发路径必须**先创建任务包**（`createTaskBundle` 需要生产调用方）；
2. 任务包随序列落盘（`dispatchEnvelope` 已有 schema）；
3. **然后**执行侧才有东西可消费。

**因此本条记为"等待前置条件"**，不写成"未做"——避免下一个人再去写一段注定走回退分支的代码。

**另记**：`task.toolNames` 到 Worker 工具端口的链路已确认
（`mission-orchestrator.ts:956` `getTaskToolNames` → `application-runtime` `buildWorkerToolPort`），
将来接信包时改这一处即可。

## 归属裁决（用户裁定，2026-11-10）——01/04 的设计约束

用户裁定如下，**作为实现与验收依据**，不得用"调度器当上级"或"默认绑主 Agent"绕过：

1. **调度器不是 Agent 的上级**：调度器只是执行机制。它直接派发的三级 Worker，
   **唯一直属上级是负责该 mission 的具体次级 Agent**，用**稳定的 `agentInstanceId`** 绑定。
2. **禁止默认绑定主 Agent**。mission 里持久化**责任次级标识**，默认绑定**实际承接并发起执行**的次级。
   若用户任务从主 Agent 进入，**必须先确定承接次级再派发 Worker**；
   **不能因缺少次级身份而退回 main**。
3. **三个概念必须分开**：原始任务发布者、mission 责任次级、Worker 直属上级。
   三级派生四级时，**四级的直属上级是该三级**，不直接挂 mission 责任次级。
   同层通信或沟通句柄转交**不改变**直属上级、任务所有权与 Git 职责。
4. **缺失/失效/不匹配 ⇒ 阻断派发并报告**，不猜测身份。
5. **恢复后保持原绑定**；交接必须走**显式受控交接**，不自动换上级。

**据此要闭合**：ALIGN-03-01（自动任命与裁决）、ALIGN-03-04（隶属校验生效）。
**必须补的测试**：①唯一上级；②恢复一致性；③跨项目拒绝。

**当前阻塞解除**：此前"Worker 所属次级是什么"未决，现已裁定为"mission 责任次级"，
因此 01/04 不再等待产品决策，可施工。

### 01/04 归属落地（第一步，2026-11-10）

按用户归属裁决实现第一批：

| 要点 | 位置 | 说明 |
|---|---|---|
| 责任次级持久化 | `mission-manager.ts` | `MissionSummary.responsibleSecondaryAgentInstanceId`（可选）；`createMission` 有值才写，**缺省不写、不伪造主 Agent** |
| 解析器 | `orchestration/worker-ownership.ts` `resolveWorkerDirectSuperior` | 纯函数；返回 `resolved`（含 `basis`）或 `blocked`（含 `reasonCode`） |
| 四级规则 | 同上 | 有派生三级 ⇒ 上级**就是该三级**（`derived-from-tertiary`），不挂 mission 责任次级 |
| 阻断原因码 | 同上 | `mission-responsible-secondary-unbound` / `responsible-secondary-is-main-agent` / `project-mismatch` / `derived-from-self` |

**证据**（`align03-worker-ownership` 8/8）：

- **唯一上级**：三级 ⇒ 责任次级（且不等于主 Agent）；
- **未绑定 ⇒ 阻断**（不退回 main）；
- 责任次级被写成主 Agent ⇒ 阻断；
- **四级 ⇒ 挂派生它的三级**；
- **跨项目拒绝**（派发目标 ≠ mission 项目 ⇒ `project-mismatch`），同项目放行；
- **恢复一致性**：责任次级落盘后读回，两次解析结果完全相同（不因重启换人）；
- 未提供责任次级 ⇒ 摘要里**无**该字段（不伪造）。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **677 files / 4607 passed + 3 skipped / exit 0**。

**未做（如实）**：解析器**尚未接入派发路径**（`DagScheduler.allocateAgentId` / Worker 登记仍未写
`owningSecondaryAgentInstanceId`）；任务完成时的**自动任命与裁决**未接；`handleUserMessage`
尚未要求/确定责任次级（从主 Agent 进入时"先确定承接次级"的路由未实现）。

### 01/04 接线前发现：**当前 mission 的"次级"就是调度器本身**（2026-11-10）

**核对**（`main-controller.ts:4038` `resolveSecondaryAgentInstanceIdentifier`）：

```ts
const agentInstanceId =
  this.options.secondaryAgentInstanceIdFactory?.(missionId) ?? `scheduler:${missionId}`;
```

⇒ 未注入工厂时，mission 的"次级主体"是 **`scheduler:<missionId>`** —— 一个**伪个体**，
而且正是用户裁决里明确否定的那种"把调度器当上级"。

**因此不能**直接把 `resolveSecondaryAgentInstanceIdentifier()` 的返回值写进
`responsibleSecondaryAgentInstanceId`：那会把"调度器"持久化成责任次级，**违反裁决**。

**正确的迁移顺序**（下一步）：

1. 为每个 assist mission 创建/指派一个**真实的次级 Agent 个体**（`agentRole: "secondary"`，
   登记进 `RegisteredAgentDirectory`），由它承接并派发；
2. `scheduler:<missionId>` 仅保留为**派发来源标签**（反馈路由等既有用途），**不再充当上级**；
3. 再把真实次级写入 `responsibleSecondaryAgentInstanceId`；
4. 然后才把 `resolveWorkerDirectSuperior` 接进派发（未绑定即阻断）。

**风险提示**：`scheduler:` 在 `main-controller`(7 处)、`mission-orchestrator`(5 处)、
`worker-agent`、`public-sdk` 等都有引用，属**跨模块迁移**，必须分批做并每批跑权威门禁；
一次性改默认身份字符串会同时动摇反馈路由与报告认证。

**本轮不改代码**：接线前提不成立，改了就是"把调度器写成上级"。

### 01/04 迁移第 1 步：mission 有了**真实责任次级**（2026-11-10）

| 要点 | 位置 | 说明 |
|---|---|---|
| 真实次级个体 | `main-controller.ts` `ensureResponsibleSecondaryAgentInstance` | `secondary:<missionId>`，以 `agentRole: "secondary"` 登记进目录；幂等（同一 mission 复用同一 id） |
| 持久化 | 同上 → `createMission({ responsibleSecondaryAgentInstanceId })` | 写入 `summary.json` |
| **不动既有标签** | — | `scheduler:<missionId>` 保留原用途（派发来源/反馈路由），本轮**未替换**，避免动摇报告认证 |

**证据**（`align03-responsible-secondary` 1/1，装配级）：
真实 mission 跑起来后读 `summary.json` ⇒ `responsibleSecondaryAgentInstanceId === "secondary:<missionId>"`，
并显式断言 **不以 `scheduler:` 开头**、**不等于主 Agent**。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **678 files / 4608 passed + 3 skipped / exit 0**。

**未做（如实）**：
1. 派发路径**尚未消费**该责任次级（`resolveWorkerDirectSuperior` 未接入，Worker 也未写
   `owningSecondaryAgentInstanceId`）；
2. 自动任命审查者 + 裁决未接（01 的正题）；
3. `scheduler:` 与真实次级**并存**，尚未把前者从"上级"语义中彻底剥离。

### 01/04 迁移第 2 步：编排层次级身份切到**真实责任次级**（2026-11-10）

`main-controller.ts` 构造编排选项处，`secondaryAgentInstanceId` 由
`resolveSecondaryAgentInstanceIdentifier(missionId)`（可能是 `scheduler:<missionId>`）
改为 `ensureResponsibleSecondaryAgentInstance(missionId)`（`secondary:<missionId>`，已登记的真实次级）。

**影响**：Worker 工作存档/集成分支属主等"次级身份"落点从调度器标签变为真实次级个体 ——
这正是裁决要求的"调度器不是上级"。

**证据**：`typecheck` / `lint` 通过；`orchestrator-git-integration`、`align03-responsible-secondary`、
`align03-tertiary-close-wiring` 定向 8/8；**权威门禁 678 files / 4608 passed / exit 0**。

**未做（如实）**：**没有直接的断言**证明"编排层拿到的就是 secondary: 而非 scheduler:"。
我尝试用 Worker 工作存档目录（`missions/<id>/agents/<agentId>/`）做断言，
实测该目录为空（存档只在任务终态写入，合成 mission 未跑到那时）⇒ **已撤掉该断言**，
不留下一条靠运气通过的测试。下一步应改为：等 mission 跑完再断言存档属主。

**仍未做**：`resolveWorkerDirectSuperior` 未接入派发；Worker 未写 `owningSecondaryAgentInstanceId`；
自动任命与裁决未接。

### 第 2 步证据补强：**失败并已撤回**（2026-11-10）

**尝试**：等 mission 跑完后读 `missions/<id>/agents/` 目录，断言存在 `secondary_<missionId>`、
不存在 `scheduler_`。

**实测结果**（打印实际目录名）：

```
实际目录=worker%3Amission-55025b2b%3AT-001%3A1
```

只有 **Worker** 的存档目录；**没有**次级自己的存档目录 —— 次级只在"集成决策"等场景写档案，
本用例的合成 mission 没走到那里。而且净化规则是 URL 编码（`worker%3A…`），不是我先前假设的 `_`。

**处置**：断言**已撤回**。理由同前：留着会失败，加条件又会变成靠运气通过。

**结论**：**当前没有可用的产物能证明"编排层身份已切换"**。要证明它，必须让 Worker
**登记进目录并带上 `owningSecondaryAgentInstanceId`** —— 那正是下一步的实现内容，
证明与实现合并做，而不是先造一个观测点。

### 01/04 迁移第 3 步：Worker 派发**登记直属上级**（2026-11-10）

| 要点 | 位置 | 说明 |
|---|---|---|
| 派发前解析 | `mission-orchestrator.ts` 派发处 | `resolveWorkerDirectSuperior` 取 `secondaryAgentInstanceId`（现为真实次级） |
| 登记 | 同上 → `registerTertiaryAgentInstance` | 写 `agentRole: "tertiary"` + `owningSecondaryAgentInstanceId` + `boundTaskBundleId = taskId` |
| 阻断 | 同上 | 解析失败且**强制开启**时：`onUserEscalation` 报告并**不派发**该任务 |
| 只读观测 | `registered-agent-directory.ts` `listAgentEntries()` | 供验收"所有三级 Worker 都带真实上级" |

**强制开关**：`isWorkerOwnershipEnforced`（缺省 false）。assist 路径已开启；
**devolve 路径未开启**（它仍是 `scheduler:<missionId>`，迁移未做）。

**为什么必须做成开关**：第一次接线时**无条件阻断**，直接让 26 条既有用例翻红
（`lesson01-dispatch-wiring` / `lesson01-receive-review-wiring` 等直接构造编排器、
没有次级身份的路径全部不再派发）。这不是测试挑剔，而是"尚未迁移的装配路径"确实没有上级。

**证据**（`align03-responsible-secondary`，装配级）：真实 mission 跑完后，
目录里**所有** `agentRole === "tertiary"` 的登记项，其
`owningSecondaryAgentInstanceId === secondary:<missionId>`，且**不以 `scheduler:` 开头**、
**不等于主 Agent**。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **678 files / 4608 passed + 3 skipped / exit 0**。

**未做（如实）**：devolve 路径未迁移（仍 scheduler 标签、未强制）；"未绑定 ⇒ 阻断"只有代码路径，
**没有专门用例**（合成 mission 总能拿到责任次级，构造不出阻断场景）；
自动任命审查者 + 裁决仍未接。

### 01/04 迁移第 4 步：**未绑定 ⇒ 阻断派发**已有用例（2026-11-10）

新增 `align03-ownership-blocking`（4 条）：

| 场景 | 期望 |
|---|---|
| 强制开启 + **无责任次级** | **不构造 Worker**，报告 `mission-responsible-secondary-unbound` |
| 强制关闭 + 无责任次级 | 照常派发（未迁移路径行为不变），不报告 |
| 强制开启 + 责任次级是 `scheduler:<missionId>` | **阻断**（新增原因码 `responsible-secondary-is-scheduler-label`） |
| 有真实责任次级 | 照常派发 |

**顺带补齐解析器**：`resolveWorkerDirectSuperior` 现在**显式拒绝** `scheduler:` 前缀
——调度器只是执行机制，不是 Agent，不能充当上级（裁决第 1 条）。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **679 files / 4612 passed + 3 skipped / exit 0**。

**仍未做（如实）**：
1. devolve 路径未迁移（仍 `scheduler:`、未强制）；
2. **自动任命审查者 + 裁决仍未接**（01 的正题：任务完成时按同一上级任命并等待裁决）；
3. 跨项目拒绝只在纯函数层有断言，**装配级没有**。

### 01 迁移第 5 步：任务成功后**自动独立任命**（2026-11-10）

| 要点 | 位置 | 说明 |
|---|---|---|
| 触发点 | `mission-orchestrator.ts` 成功收尾后 | 只触发、不代劳；任命失败只报告，**不反转完成状态** |
| 任命实现 | `main-controller.ts` `onTaskCompletedForIndependentReview` | 登记 `reviewer:<mission>:<task>`（三级，挂在**同一责任次级**下），再调 `appointExecutionAndReview` |
| 开关 | `isIndependentReviewAutoAppointmentEnabled`（控制器 + 运行时，缺省 **false**） | 没有真实审查 Worker 前开启会让任务停在"待裁决"，故默认关闭 |

**证据**（`align03-auto-review-appointment`，装配级 2/2）：

- 开启 ⇒ 真实 mission 跑完后目录里出现 `reviewer:*`，其 `owningSecondaryAgentInstanceId === secondary:<missionId>`，
  且**不等于**贡献者个体（非自审）；
- 关闭 ⇒ 无审查者（行为不变）。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **680 files / 4614 passed + 3 skipped / exit 0**。

**仍未做（如实）**：
1. **默认关闭** ⇒ 生产里仍不自动任命（需要真实审查 Worker 才能开启，否则任务会卡住）；
2. **裁决（verdict）仍未自动产生** —— 只做到"任命"，没有审查者执行与结论；
3. devolve 路径未迁移；跨项目拒绝缺装配级用例。

### 01/04 迁移第 6 步：**devolve 路径也迁移**（2026-11-10）

此前 devolve 构造编排器时仍用 `scheduler:<missionId>` 作次级身份、且未强制归属。

**改动**（`main-controller.ts` devolve 装配处）：
- `secondaryAgentInstanceId` 改为 `ensureResponsibleSecondaryAgentInstance(missionId)`（真实次级个体）；
- 加 `isWorkerOwnershipEnforced: true`。

**依据**：裁决原文"若用户任务从主 Agent 进入，必须先确定承接次级，再派发 Worker；
不能因缺少次级身份而退回 main"。devolve 由主 Agent 直接调度，正是这一条的场景。
**报告语义不变**：devolve 仍不产生"下级报告"。

**证据**：`tests/core/integration` 全量 **1117 passed**；权威门禁
`npx vitest run --maxWorkers=1` ⇒ **680 files / 4614 passed + 3 skipped / exit 0**。

**仍未做（如实）**：裁决（verdict）闭环未做——只任命、无审查者执行与结论；
跨项目拒绝缺装配级用例。

### 01 裁决闭环：**产物证据驱动的结论**（2026-11-10）

缺口：只"任命审查者"不够 —— 没有结论，任务永远停在待裁决。

**交付**：`orchestration/artifact-backed-verdict.ts` `produceArtifactBackedVerdict`

| 输入 | 结论 |
|---|---|
| 产物存在且非空 | `merge-ready`，证据 `artifact:<path>` + `artifact-bytes:<n>`（+ 可选 `commit:<sha>`） |
| 产物缺失 / 空 / 越界 / 未登记路径 | `rework`，**不抛错**（"未产出"≠"审查失败"） |

**关键设计**：证据前缀是 `artifact:` / `artifact-bytes:` / `commit:`，**不是**
`self-report:`/`executor-report:`/`agent-claim:` —— 因此独立验收门禁不会把它当"执行者自报"拒绝，
而执行者也**无法**用自报伪造这条证据（它必须真的有一个非空文件）。

**边界（如实标注，已写进模块注释）**：这是**本地产物存在性**验收，
**不是**模型审查、**不是**人工验收。它只能回答"产物是否真的产出且非空"，
不能回答"内容是否正确"。

**证据**（`align03-artifact-backed-verdict` 6/6）：存在 ⇒ merge-ready 且证据非自报；
缺失 ⇒ rework 不抛错；空文件 ⇒ rework；未登记路径 ⇒ rework；越界 ⇒ rework；带 commit ⇒ 证据含 `commit:`。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **681 files / 4620 passed + 3 skipped / exit 0**。

**仍未接线**：该产出器**尚未**接进自动任命回调（下一步：任命后立即产结论并 `recordAcceptanceVerdict`）。

### 01 裁决闭环**已接通**（2026-11-10）

任命后立即产结论并落盘：`onTaskCompletedForIndependentReview` →
`produceArtifactBackedVerdict` → `recordAcceptanceVerdict`。

**三个身份必须互不相同**（这是接线过程中被门禁连续拒绝两次才理清的）：

| 角色 | 谁 |
|---|---|
| 实现者 | 派发出的 Worker |
| 测试者 | **责任次级** |
| 验收者 | `reviewer:<mission>:<task>`（三级，挂同一责任次级） |

踩坑记录：
1. 测试者 = 实现者 ⇒ 拒绝（"作者自验被拒"）；
2. 测试者 = 验收者 ⇒ 拒绝（"测试者不能签发自己的验收结论"）；
3. `rework` 结论**证据为空** ⇒ 拒绝（空证据被当"只有自报"）⇒ 改为 `check:artifact-<kind>:<path>` 这类**检查结果**证据。

**证据**（装配级 3/3）：
- 开启 ⇒ 出现 `reviewer:*`，`owningSecondaryAgentInstanceId === secondary:<missionId>`，非贡献者；
- **无产物 ⇒ 裁决落盘为 `rejected`，且文件里不出现 `"accepted"`**（不因"任务报成功"就自动通过）；
- 关闭 ⇒ 无审查者。

**权威门禁**：`npx vitest run --maxWorkers=1` ⇒ **681 files / 4621 passed + 3 skipped / exit 0**。

**仍未做（如实）**：
1. **默认关闭**（`isIndependentReviewAutoAppointmentEnabled`），生产里尚不启用；
2. 验收只依据**产物存在性**，不判内容正确性；
3. 跨项目拒绝缺装配级用例。

### 01 闭环最终形态（2026-11-10 收口，取代此前"产物即结论"的做法）

**用户裁决**：ALIGN-03-01 对应**原设计的独立测试/验收闭环**，不是新增实验性功能；
"产物存在且非空即 merge-ready"**不得**默认启用；禁止仅登记 reviewer 身份便视作完成独立审查；
禁止审查失败后仍宣称任务最终完成。

#### 实现边界（三层分离）

| 层 | 模块 | 作用 |
|---|---|---|
| 产物前置 | `artifact-precondition.ts` | 只回答"有没有可送审的产物"；**类型上没有 verdict 字段** |
| 状态机 | `independent-review-closure.ts` | `execution-done / pending-acceptance / rework / accepted`；**只有 accepted 允许对外宣称完成** |
| 审查任务 | `independent-review-task.ts` | 构造真实 `taskType: "review"` 节点、解析报告、裁决消费 |

#### 产物与报告都取自**完成收据**（不是 `resultLocation`）

- 执行任务：`completionReceipt.artifactPaths` ⇒ 送审前置；
- 审查任务：`completionReceipt.artifactPaths[0]` ⇒ 报告路径；
- **为什么**：`resultLocation` 在既有流程里另有消费者，回填它会把返修任务卡成 `blocked`（实测）。

#### 审查任务必须能写出报告

`toolNames: ["createProjectFile"]`。否则审查者"只能想不能留证"，
裁决永远因"没有可采信结论"失败（实测）。

#### 报告契约

```
VERDICT: accept|rework
EVIDENCE: <可复核引用>
```

- **无裁决行 ⇒ 不合规**；`accept` **无 EVIDENCE ⇒ 不合规**；
- `EVIDENCE: artifact:<path>` 必须命中**本次送审产物**，否则
  `check:review-evidence-mismatch` ⇒ rework（防引用别的文件冒充）。

#### 装配

`buildIndependentReviewOrchestrationOptions()` 由 **assist 与 devolve 共用**，
受 `isIndependentReviewAutoAppointmentEnabled` 控制（**默认关**，关时返回空对象、行为不变）。

#### 证据

| 用例 | 覆盖 |
|---|---|
| `align03-review-loop-e2e`（6） | 组合：收据⇒派发⇒报告⇒裁决；**任务级**：devolve 任务写文件 ⇒ 注入 `review:*` ⇒ 审查 Worker 写报告 ⇒ `"verdict": "accepted"`（decider = reviewer） |
| `align03-independent-review-task`（21） | 节点构造、报告解析、证据命中/不命中、收据解析四条异常路径 |
| `align03-independent-review-closure`（11） | 四态推导 + 禁止身份冒充 + 唯一完成判定 |
| `align03-artifact-precondition`（5） | 多产物、空收据、越界 |
| `align03-auto-review-appointment`（3） | 装配面：审查者登记、无产物 ⇒ rejected、关闭 ⇒ 无审查者 |

#### 仍未做（如实）

- **默认开关未启用**（用户裁决：等验收后再决定）；
- 审查者由脚本桩扮演，**尚未接入真实模型审查**（裁决质量取决于真实审查 Worker）；
- 人工点击验收未做。

### 巡检轮（2026-11-12）：完成收据**补测试**（此前零覆盖）

盘点发现 `packages/core/src/orchestration/completion-receipt.ts` 被
`main-controller` / `artifact-precondition` / `goal-requirement-assessment` 使用，
但 `tests/` 下**零引用** —— 生产路径上的"完成是否成立"判定没有自动化守护。

新增 `tests/core/unit/align03-completion-receipt.test.ts`（6 条，全绿）：

| 用例 | 断言 |
|---|---|
| ① 无收据 | 不足，原因含"缺少完成收据"（不补默认收据） |
| ② 要求完成事件但未声明已校验 | 不足 |
| ③ 缺任务标识 | 判定不足；`buildCompletionReceipt` 直接抛错 |
| ④ 工具计数负数/非整数 | 不足 |
| ⑤ 空产物路径 | 不足（宁可 block 不谎报） |
| ⑥ 合法收据 | 足够；构造出的产物数组是副本，外部修改不污染 |

**性质**：补的是**证据**，实现本身未改动（判定行为符合卡内"缺失即不足"）。

### 巡检轮（2026-11-12）：`IndependentReviewGate` **补测试**（此前零覆盖）

系统扫描 `packages/core/src/orchestration` 下**在 `tests/` 无任何引用**的模块（共 20 个），
其中 `independent-review-gate.ts` 是安全判定（"谁有权任命、谁有权签字、拿什么签字"）且被装配使用，
却**零测试引用**。已补 `tests/core/unit/align03-independent-review-gate.test.ts`（9 条，全绿）：

| 用例 | 断言 |
|---|---|
| ① 自报证据判定 | 空 / 全 `self-report:` `executor-report:` `agent-claim:`（含大写）⇒ 只有自报；混入 `test-output:` ⇒ 不算 |
| ② 任命者自签 | 拒绝（自审被拒） |
| ③ 验收者未登记 | 拒绝（非空字符串不是认证） |
| ④ 验收者不属于任命次级 | 拒绝（不得借人签字） |
| ⑤ 验收者非三级 | 拒绝 |
| ⑥ 实现者/测试者自签裁决 | 均拒绝 |
| ⑦ 只有自报证据 | 拒绝 |
| ⑧ 理由空白 | 拒绝 |
| ⑨ 合法裁决 | 通过并落盘（`merge-ready ⇒ accepted`） |

**性质**：只补证据，实现未改动。**剩余未测模块 19 个**（含 `goal-gate-cache`、`main-agent-turn-budget`、
`remote-*`（平台阻塞）、各 `*-store`），可继续按"生产路径 + 安全语义"优先级逐个补测。

### 目标轮（2026-11-12）：`GoalGateCache` 补测试 + 拆掉**时间炸弹**断言

**① `GoalGateCache`（此前零引用）** —— `tests/core/unit/align03-goal-gate-cache.test.ts`（7 条）：
无绑定 ⇒ 空缓存；契约缺失 / 状态缺失 / 实验关闭 / revision 不匹配 / 快照非法 ⇒ 五种问题各自记录且**均不还原门禁**；
`hydrate` 是**重建**而非累加（第二次仍失败时缓存为空、问题不重复堆积）。
语义原则：**宁可还原失败，也不把半截门禁放回缓存**。

**② 顺带发现并修掉 4 个"时间炸弹"断言（真实测试缺陷）**
`cluster01` 的 4 个套件把 `generatedAtIso` 写死为 `2026-11-11T00:00:00Z`，随后用**真实时钟**读 `readLatest` 断言 `ready`——
TTL 24h，日期一过**必红**。已改为：写入用当前时间（或给服务注入固定时钟），`ready`/`stale` 语义不变。
这类缺陷的危害是：绿色会**悄悄过期**，之后被误当成"近期改动引入的抖动"。

**仍未测模块 18 个**（`remote-*` 跳过），下一轮按顺序：`main-agent-turn-budget` → `task-ledger-divergence-journal`。

### 目标轮 2（2026-11-12）：`main-agent-turn-budget` 补测试（此前零引用）

`tests/core/unit/align01-main-agent-turn-budget.test.ts`（6 条，全绿）：

| 用例 | 断言 |
|---|---|
| ① | 预算 = **180 秒**，且与 `MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS` **同源** |
| ② | completed / timed-out / cancelled **三种 outcome 下 `isTaskDispatched` 均为 false** |
| ③ | 超时 ⇒ 文案含"补充信息""没有派发任何任务"，**不含"已完成"**，并保留已产出字数与 elapsed |
| ④ | 完成态明确"答复完成**不等于任务已派发**" |
| ⑤ | 取消态明确"没有派发任何任务" |
| ⑥ | 时钟回拨时 `elapsed` 归零、时间戳为 ISO |

**门禁**：本轮首次全量出现 1 个失败（`ponder-readonly-tools-production-wiring`），
**隔离重跑 2 条全过**、再跑全量 **742 files / 4910 passed** ⇒ 判为并发抖动，未改任何断言。

**未测模块剩 17 个**，下一轮：`task-ledger-divergence-journal`。

### 目标轮 3（2026-11-12）：`task-ledger-divergence-journal` 补测试 + **修一个真实缺陷**

`tests/core/unit/task-ledger-divergence-journal.test.ts`（7 条，全绿）：空读 / 追加与 revision / 连续相同只记一次 /
非连续 A,B,A 各记一次 / **不同 mission 的相同漂移分别记录** / 超上限丢最旧 / 文档损坏读作空。

**测试暴露的真实缺陷（已修）**：`divergenceHash` 只含 `sequenceRevision + 差异清单`，**不含 mission / sequence 归属** ⇒
两个不同 mission 出现**相同漂移**时，第二条被当成"连续重复"**静默丢弃**，历史查询里少了一整个 mission 的分歧记录。
修复：去重键加入 `missionIdentifier` 与 `sequenceIdentifier`；`recordedAtIso` / `trigger` 仍不参与（同一漂移在不同时间观察到仍算同一条）。

**未测模块剩 16 个**，下一轮：`completion-verdict-store`。

### 目标轮 4（2026-11-12）：`completion-verdict-store` 补测试（此前零引用）

`tests/core/unit/completion-verdict-store.test.ts`（7 条，全绿）：

| 用例 | 断言 |
|---|---|
| ① | 缺 mission / task 标识 ⇒ 拒绝 |
| ② | 裁决者为空（匿名/角色名）⇒ 拒绝 |
| ③ | 时间非法 ⇒ 拒绝 |
| ④ | `rejected` **必须**给理由；`accepted` 理由可空 |
| ⑤⑥ | 首次写入可读回；**同内容重复写入幂等**（`didWrite=false`） |
| ⑦ | 同 mission/task **不同内容 ⇒ 拒绝覆盖**（裁决不可事后改写），原裁决保持不变 |
| ⑧ | `listForMission` 按 task 排序；**损坏文件读回 null 且不掺入列表**；未知 mission ⇒ 空 |

**未测模块剩 15 个**，下一轮：`goal-contract-store`。
