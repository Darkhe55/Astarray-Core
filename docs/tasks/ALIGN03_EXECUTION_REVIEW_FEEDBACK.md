# ALIGN-03：下级执行、次级审查集成与报告闭环

日期：2026-10-27。状态：in_progress（01–05 部分交付，implemented-unverified；2026-10-28）。

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
