# ALIGN-04：主干重启恢复与完成状态纠偏

日期：2026-10-27。状态：in_progress（01–05 部分交付、06 文档交付，implemented-unverified；2026-10-28）。

执行约定：只修改本卡负责范围；先备份覆盖前文件，保留并行工作。每轮一个编号步骤，超过 3 小时拆分剩余步骤继续。允许更新本卡与所属仓库索引，不授权安装依赖、提交推送或调用真实付费模型。本轮沿用用户要求，不编写/运行测试，不构建或人工验收；按源码调用链交付证据，完成只能标 implemented-unverified，不得宣称运行验证通过。既有测试和 CI 不删除、不弱化。发现相关实现已存在则复用，不重复造轮子；缺少可信授权或遇并行覆盖冲突只阻塞对应步骤。具体模型是否曾替换设计无可靠证据，不作来源归罪。

前置：ALIGN-01/02/03。负责持久关系、租约恢复、任务对账与核心任务状态；不处理工作中目录迁移。
## 固定实现
1. 持久化 project/conversation/agent/sequence/group/mission 的显式关联，不只保存在 MainController 的 Map。重启从权威记录恢复映射，不从昵称或路径字符串猜归属。
2. 恢复先只读对账：哪些已完成、哪些租约失效、哪些副作用未知、哪些等待授权。用户可查看历史但查看不启动任务；旧授权不可仅凭恢复档案重用。
3. 获得现有合法恢复许可后从未完成且 ready 的节点恢复，执行恢复租约幂等领取；已产出但未回执的结果先对账，不盲目重跑。对不确定副作用保持待裁决。
4. 工作时段到期恢复复用同一调度入口，区分人工暂停和休息暂停；只唤醒有恢复资格的任务。不得引入另一份自动恢复队列。
5. 保留原始上下文及个体档案，按节点关闭/回访重建必要上下文；不把全局摘要当完整历史，不通过拼接全部角色日志恢复。
6. 按调用链修正核心计划状态：接口存在、组件存在、生产接线、代码完成、运行证据分别登记。空回调/硬编码假值/未持久化关联列为未完成，历史证据按原版本保留。
## 交付
新建同目录 ALIGN_CORE_HANDOFF.md，逐卡列出入口/控制器/存储/消费者/结果回流、剩余问题、备份和未验证说明。不得引入外部界面材料。
全部编码到位才标 implemented-unverified；不把此次静态检查写成恢复验收通过。


## 检查点记录

### 01 mission 关系索引与重启恢复——**部分交付**（2026-10-28）

**审查发现**：project/conversation/sequence/agent 映射此前**只在 `MainController` 的进程内 Map**；
`summary.json` 只有 project/conversation/sequence 三个字段，没有 agent/owner/group 的显式记录，
也没有任何"重启恢复映射"的代码路径。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 索引存储 | `packages/core/src/orchestration/mission-relation-index.ts` | 一 mission 一文件 `<state>/mission-relations/<id>.json`（原子写 + `.bak` + revision）；合并登记（`undefined` 保留原值、数组取并集）；损坏即抛错不冒充"无关联" |
| 写入 | `main-controller.ts` `recordMissionRelation` | mission 创建后登记 project/conversation/主个体/序列/序列 owner/参与个体；失败经 `streamOutput` 如实告知 |
| 恢复 | `hydratePersistedMissionRelations` | 只恢复记录写过的字段；会话与身份存储核对，查不到**不恢复**、计入 `unresolvedConversationCount`；序列 revision 置 0（未知） |
| 启动接线 | `application-runtime.ts` | 构造后立即 `await hydrate…`；失败写 stderr、不阻断启动 |
| 防猜测 | `requestRuntimeTaskInsertion` | revision 未知（0）⇒ `stale-revision`，要求重新读取后再插入 |

**未做（如实）**：group（任务包）未写入（`createTaskBundle` 无生产调用方）；个体清单只有主/序列 owner/目标 agent，
三级 Worker 未补登记；旧 mission 无关系文件（恢复不会猜，迁移入口未实现）；`unresolvedConversationCount`
只作为返回值无 UI 呈现；未跑过"写入 → 重启 → 恢复 → 插入被拒"完整链路。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 02 恢复前只读对账门禁——**部分交付**（2026-10-28）

**审查发现**：`RecoveryCenterController` / `ReadonlyReconciliationService` / `RecoveryClassificationService`
都已相当完整（含"不确定副作用 ⇒ 阻断""一次性授权不延续"字段），但 **`MainController.resumeMission`
从不咨询它们** —— 只要 mission 有未完成任务就重新调度，状态损坏/检查点需对账/租约冲突都不拦。
历史查看本身已只读、不启动任务（已成立）；恢复不读历史批准记录（旧授权不会因恢复被复用），
但也没有显式检查。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 门禁入口 | `main-controller.ts` `resumeMission` | 先调 `missionRecoveryGate`；拒绝 ⇒ `mission-locked` + 全部原因，**不写 running、不启动调度** |
| 只读判定 | `application-runtime.ts` 构造的 gate | 只调 `RecoveryCenterController.inspectMission`（摘要/任务链/租约/检查点只读） |
| 阻断条件 | 同上 | 不存在 / `isCorrupted` / `reconciliationRequired`（必须先完成对账，门禁**不代替**对账） |
| 查看 ≠ 恢复 | — | 历史与恢复视图只读；恢复只能由显式 `resumeMission` 触发 |
| 不继承授权 | — | 恢复不读取历史批准；权限仍由既有权权限引擎重新询问 |

**未做（如实）**：门禁**默认关闭**；只拦不代劳（不执行 Git/worktree/人工改动对账）；
租约冲突未纳入判定；`reauthorizationRequiredTypes` 未被消费；未跑"损坏 ⇒ 拒绝""需对账 ⇒ 拒绝"
"正常 ⇒ 续接"任何一条。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 03 就绪分类 / 已产出待对账 / 租约幂等领取——**部分交付**（2026-10-28）

**审查发现**：`resumeMission` 把**所有非 done 任务**整体重跑 —— 包括崩溃时 `running`（副作用未知）、
`blocked`（等待裁决）、以及**已写 `resultLocation` 却未回执**的任务。租约 `tryAcquire`
对**同进程重入**也返回 `locked-active`（恢复把自己挡在门外）；`takeOverExpiredLease` **零调用方**，
编排器遇到 `locked-stale` 只抛"过期待接管"。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 就绪分类 | `main-controller.ts` `projectMissionResumeReadiness` | running ⇒ 副作用未知；blocked ⇒ 等待裁决；resultLocation 非空未 done ⇒ 已产出未回执；任一类存在 ⇒ `isAutoResumable=false` |
| 只读投影 | `inspectMissionResumeReadiness(missionId)` | 同分类 + ready/等待依赖分开；**查看不启动任务** |
| 恢复拒绝 | `resumeMission` | 不可自动恢复 ⇒ `mission-locked` + 具体任务清单 |
| 租约幂等 | `infra/mission-lease-store.ts` `tryAcquire` | 同 `processInstanceId` 重入 ⇒ `acquired-reentrant`；编排器同时接受两种 acquired |
| 租约接管 | `main-controller.ts` `prepareResumeLease` | 别的进程活动租约 ⇒ 拒绝；**过期租约**按 revision CAS 接管；本进程持有则跳过 |

**未做（如实）**：**没有对账动作**（不会把 running/blocked/已产出任务放回 pending 或记录对账结论）；
已产出核对只看"有没有 resultLocation"；租约接管只处理**已过期**（不探测"属主进程已死但未过期"）；
未跑"崩溃 running ⇒ 拒绝恢复""过期租约 ⇒ 接管成功"任何一条。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 04 工作时段恢复：同一入口 + 暂停来源区分——**部分交付**（2026-10-28）

**审查发现**：`evaluateWorkWindowResume`（rest→working 只恢复一次、手动取消不复活、休息中不发请求）
**已实现但零调用方**；`resumeMission` 也**没有"是否已在运行"的幂等守卫**
（重复恢复会启动第二个调度器 ⇒ 同一任务跑两遍）。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 同一入口 | `main-controller.ts` `handleWorkWindowResume` | 只有 `resume-once` 才调 **`resumeMission`**（复用 04-02 门禁 / 04-03 就绪分类 / 租约），**不新建队列** |
| 暂停来源 | 同上 | `pauseKind:"manual"` 按手动取消抑制；`"rest"` 才允许 rest→working 恢复一次；人工暂停优先于入参 |
| 最多一次 | 同上 | `hasResumedSinceWake` ⇒ `already-resumed`，不动作 |
| 运行中防重 | `resumeMission` 开头 + `handleWorkWindowResume` | `activeOrchestrators` 已存在 ⇒ `already-running`；调度器结束后 `.then` 清理该记录 |
| 如实返回 | 同上 | 被拒 ⇒ `resume-rejected` + 原因、`didResume:false` |
| 事件唤醒 | 同上 | 恢复成功 ⇒ `notifySchedulingEvent("work-window-resumed")` |

**未做（如实）**：**没有时段变化检测器**（谁在 rest→working 时调用入口未接线）；`hasResumedSinceWake`
由调用方维护、未持久化；`pauseKind` 无权威标记（不由暂停原因存储推导）；未跑任何一条判定路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 05 胶囊 → 回访：按节点关闭重建上下文——**部分交付**（2026-10-28）

**审查发现**：节点收口链路完整（`ContextNodeLifecycleController` → `ContextClosureCapsuleStore`，
胶囊不可变 + contentHash + owner/mission/node），但 **`ContextRecallController` 从未被构造**
⇒ 胶囊**只写不读**，"按节点关闭/回访重建"在产品里不可达。顺带核对两处"看似违规"路径，
结论是**没有**违规：重试档案附加按 `taskId` 过滤且按属主分别生成附件；没有路径把全局摘要当完整历史。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 回访入口 | `main-controller.ts` `recallClosedContext` | 未装配 ⇒ `context-recall-invalid`（拒绝伪造历史）；空身份直接拒 |
| 按调用者构造 | `application-runtime.ts` `contextRecallControllerFactory` | 每个调用者独立 `FileContextRecallLedgerStore`（冷却/预算互不干扰） |
| 内容边界 | `ContextRecallController` | 输入面只有节点/revision/原因码/token 上限 —— **没有**"全部 Agent/全局摘要当历史"字段，越权组合结构上不可表达 |
| 既有约束 | 未改 | 次数上限活锁拒、冷却 `repeat-receipt`、敏感命中丢弃、token 预算有界 |

**未做（如实）**：**未注入提示词装配**（组装上下文时不会自动回访，只能由上层显式调用）；
`nodeIndexProvider`/`fullFragmentProvider` 未接管（无胶囊节点 ⇒ `not-found`）；
敏感判定用默认实现（未接 SEC-02 DLP）；未跑任何一条回访路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 06 调用链状态登记与交接——**已交付（文档）**（2026-10-28）

**交付**：`docs/tasks/ALIGN_CORE_HANDOFF.md` —— 按卡逐检查点登记
**接口存在 / 组件存在 / 生产接线 / 代码完成 / 运行证据** 五层状态，并列出：
①默认开关一览（5 个，含缺省与行为变化）；②未完成项按"结构性 / 缺生产能力 / 缺外部条件 / 未验证"分类；
③备份位置与提交可回溯；④按解除阻塞收益排序的下一步建议。

**如实结论**：ALIGN-01…04 共 26 个检查点里，**没有一个有运行证据**（本窗口口径不写/不跑测试）。
"代码完成"仅表示通过 `typecheck`/`eslint`/`build`。

**登记出的结构性问题（最重要三条）**：
1. **两套记账**：权威任务序列 vs mission 任务链；orchestrator 没有按 taskId 领取/派发/插入的公开 API；
2. **没有自动触发点**：任命/裁决、信包、完成收据、生命周期收口、胶囊回访都只有控制面入口；
3. `SecondaryContinuousDispatchLoop` 是第二套调度器，从未被生产调用。

**验证状态**：文档交付；未编写/未运行测试。

### 03 租约语义：幂等重入与过期接管已跑（2026-11-09 追加）

**缺口（本卡记录）**："未跑'崩溃 running ⇒ 拒绝恢复''过期租约 ⇒ 接管成功'任何一条"。

**本轮**：为 `MissionLeaseStore` 补 7 条测试，覆盖租约侧三条语义：

| 用例 | 期望 |
|---|---|
| 首次获取 | `acquired` |
| **同进程重入** | `acquired-reentrant`（**不是** `locked-active`；恢复不再把自己挡在门外） |
| 别的进程持活跃租约 | `locked-active`（不得抢占） |
| **过期租约 + tryAcquire** | `locked-stale`（提示需接管，而非直接抢占） |
| **过期租约 + revision 正确** | 接管成功，属主变为新进程 |
| revision 不匹配 | 拒绝（`revision`） |
| **未过期**租约 | 禁止接管（`mission-locked`） |

**测试构造要点（如实记录）**：租约到期时间由**存储的** `leaseTtlMilliseconds` 与
`nowMilliseconds` 决定，**不是** claim 字段 —— 初版我把 `renewsUntilIso` 放进 claim，
结果租约永不过期，三条用例假红。改用可控时钟后通过。

公开全量 **667 files / 4550 passed + 3 skipped**。

**仍未做（如实）**：**"崩溃 running ⇒ 拒绝恢复"的应用级用例仍未跑**（需构造 mission 处于 running
且进程消失的场景）；对账动作（把 running/blocked/已产出任务放回 pending）仍未实现；
"属主进程已死但未过期"的探测未做。

### 03 崩溃 running ⇒ 拒绝恢复（2026-11-09 追加）

**缺口（本卡记录）**："未跑'崩溃 running ⇒ 拒绝恢复'任何一条"。

**本轮**：用**只读投影** `inspectMissionResumeReadiness` 补 4 条应用级用例
（不启动真实 mission，只把任务链写进存储再问"能不能自动恢复"）：

| 场景 | 期望 |
|---|---|
| **崩溃留下 `running`** | `isAutoResumable=false`，该任务进 `uncertainSideEffectTaskIdentifiers`，且 `blockedReasons` 非空 |
| `blocked` | 不可恢复，进 `blockedAwaitingDecisionTaskIdentifiers` |
| 有 `resultLocation` 却非 done | 不可恢复，进 `producedButUnacknowledgedTaskIdentifiers` |
| 只有干净 `pending` | **可以**恢复，进 `readyPendingTaskIdentifiers`（不误伤正常场景） |

公开全量 **668 files / 4554 passed + 3 skipped**（首次运行有 1 条既有 `anthropic-messages-runtime`
用例在满载下翻红，隔离 24/24 通过后重跑全量绿）。

**仍未做（如实）**：**对账动作**（把 running/blocked/已产出任务放回 pending 或记录对账结论）仍未实现
—— 本轮只验证"拒绝自动恢复"这一侧；"属主进程已死但租约未过期"的探测仍未做。

### 05 回访入口：拒绝路径已跑，并更正一处旧陈述（2026-11-09 追加）

**缺口（本卡记录）**："未跑任何一条回访路径"。

**本轮**：补 2 条入口级用例：

| 场景 | 期望 |
|---|---|
| 调用者身份为空 | 拒绝（`context-recall-invalid`，身份由 harness 注入） |
| 请求未绑定必要字段 | 拒绝（`回访请求非法…`） |

**更正旧陈述（如实）**：卡内写"`contextRecallControllerFactory` 未装配"，但实测**默认已装配** ——
走的是**请求校验**分支而非"未装配"分支。因此"未装配 ⇒ 拒绝伪造历史"这条**当前不可达**
（除非装配方显式移除），已在测试注释中标注。

公开全量 **669 files / 4556 passed + 3 skipped**。

**仍未做（如实）**：**成功路径未跑**（需要真实关闭胶囊 + `nodeIndexProvider`/`fullFragmentProvider`）；
**提示词装配仍未注入回访**（组装上下文时不会自动回访，只能上层显式调用）—— 这是本检查点的主缺口。

### 04 工作时段恢复：判定路径已跑 + 一处旧陈述更正（2026-11-09 追加）

**缺口（本卡记录）**："未跑任何一条判定路径"；"没有时段变化检测器"。

**更正旧陈述（如实）**：`createWorkWindowTransitionMonitor` **已构造并 `start()`**
（`application-runtime.ts:2758/2799`）——"没有检测器"是 2026-10-28 的旧状态，**已过期**。

**本轮**：为 `evaluateWorkWindowResume` 补 7 条判定用例：

| 场景 | 期望 |
|---|---|
| rest→working 且有待恢复业务 | `resume-once` |
| **手动取消** | `suppressed-by-manual-cancel`（唤醒**不得**复活） |
| 仍在休息 | `no-new-business-calls`（不发模型请求） |
| 无待恢复业务 | `nothing-pending` |
| **本次唤醒已恢复过** | `already-resumed`（不跑两遍） |
| 状态未变化（抖动） | `nothing-pending` |
| 每条判定 | 原因**非空** |

公开全量 **670 files / 4563 passed + 3 skipped**（首次运行有 1 条既有 `g3-high-rigor-evidence`
用例满载翻红，隔离 3/3 通过后重跑绿）。

**仍未做（如实）**：`hasResumedSinceWake` **未持久化**（由调用方维护，进程重启即丢）；
`pauseKind` 无权威标记（不由暂停原因存储推导）。

### 04 `hasResumedSinceWake` 未持久化 —— 核对结论：**不是功能缺口**（2026-11-10）

卡内记录："`hasResumedSinceWake` 由调用方维护、未持久化"。

**核对**（`application-runtime.ts:2788` + `work-window-deferred-mission-store.ts:238`）：

- 唤醒回调里 `hasResumedSinceWake` **恒为 `false`**（硬编码）；
- 但"最多恢复一次"由**队列移除**保证：`resumeDeferredWorkWindowMissions` 在
  `didResume === true` **或** `decision === "already-running"` 时
  `store.remove(missionIdentifier)` —— 恢复过的 mission 不会再出现在下一次唤醒的列表里。

**结论**：对**延迟队列这条路径**，"恢复两次"的防护**已经成立**（靠移除而非靠标志位）。
标志位不持久化只影响"同一进程内多次调用 `handleWorkWindowResume` 且不走队列"的场景，
那是控制面直接调用，语义上应由调用方决定。

**因此本轮不改代码**：把 `hasResumedSinceWake` 持久化会引入"何时重置"的新语义
（按唤醒周期？按进程启动？），在没有产品定义前加进去只会制造一处难以解释的状态。

**仍未做（如实）**：`pauseKind` 无权威标记（不由暂停原因存储推导）—— 这条是真的缺口，未核对完。
