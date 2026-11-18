# 跨进程存储写保护审计（2026-11-18）

**目的**：把"哪些状态文件已经跨进程串行、哪些靠 CAS/乐观并发自保、哪些仍有丢更新风险"写成一张可核对的表，
避免下一轮重复劳动，也避免"看着有锁其实没护住"。

**背景**：进程内互斥锁（`AsyncMutex`）管不到另一个进程。以下分类针对"两个进程同时读-改-写同一文件"的场景。

## A. 已接入统一文件锁（`core/src/infra/file-lock.ts`）

| 存储 | 保护点 | 反例（摘掉锁会红） |
|---|---|---|
| `infra/task-store.ts` | `writeTaskChain` / `updateTaskChain` | 两实例并发 40 次更新 ⇒ revision 落后 |
| `orchestration/coordination-task-application-ledger.ts` | `recordIntent` / `updateEntry` | 40 条只剩 **1 条** |
| `orchestration/context-admission.ts` | `admit` / `recordDelivered` | 40 条准入、同消息并发投递均红 |
| `feedback-process/mailbox-journal.ts` | `runExclusive` 内叠加 | 40 条只剩 **20 条** |
| `orchestration/artifact-record-store.ts` | `register` / `verify` | 40 个产物只剩 **27 条** |
| `orchestration/mission-task-sequence-map-store.ts` | `bind` / `removeForMissionTask` | 40 条映射只剩 **20 条** |
| `orchestration/comm-delivered-message-store.ts` | `recordDelivery` | 40 条只剩 **20 条** |
| `orchestration/deferred-insertion-queue.ts` | `enqueue` / `markConsumed` | 40 条只剩 **20 条** |
| `orchestration/mission-sequence-binding-store.ts` | `bind` | 40 条绑定只剩 **20 条** |
| `orchestration/mission-relation-index.ts` | `upsert` | 同一 mission 的并发成员追加互相抹掉 |
| `orchestration/context-recall-ledger-store.ts` | `writeEntry` / `writeTaskRecallCount` | 40 条只剩 **30 条** |
| `orchestration/coordination-submission-identity.ts` | `submit` | 40 条只剩 **1 条** |
| `orchestration/coordination-retry-store.ts` | `recordFailure` / `recordSuccess` | 并发失败记录互相覆盖（计数与退避丢失） |
| `orchestration/goal-requirement-mapping-store.ts` | `setMapping` | 40 条映射只剩 **20 条** |

## B. 复核后**不需要**加锁（已有并发保护，故意不动）

| 存储 | 依据 |
|---|---|
| `orchestration/agent-task-sequence-store.ts` | `updateSequence` 用 `expectedRevision`，冲突显式报 `stale-revision`，不静默丢 |
| `orchestration/collaboration-inbox-store.ts` | `save` 用 `expectedRevision` + `beforeCommit` 提交前复核 |
| `orchestration/coordination-state-transaction.ts` | fencing token + `stateVersion` CAS + `appliedMessages` 幂等 |

> 这三处若再加文件锁，会把"显式失败"变成"排队等待"，改变既有语义；因此保持原样。

## C. 仍待评估（`readJsonWithBackupRecovery` + `writeAtomicJson`，无锁也无 CAS）

按"是否累积条目"判断优先级：

**C1. 累积型（丢更新 = 功能不可见，优先）**

- `remote-delivery-outbox`
- `goal-dispatch-verdict-journal`
- `task-ledger-divergence-journal`
- `prompt-scan-journal-store`

**C2. 单文档整写（最后写入者胜，通常可接受）**

- `goal-mode-store`、`goal-contract-store`、`goal-contract-proposal`、`goal-mission-binding-store`
- `startup-recovery-policy`、`startup-recovery-report`、`startup-recovery-runner`
- `conversation-identity-store`、`agent-edit-intent-guard`、`cross-project-transport`
- `completion-receipt-store`、`completion-verdict-store`（按任务/裁决键分文件）
- `work-window-deferred-mission-store`
- `toolkit/*`（工具包生命周期/版本状态）

> C2 是否也要统一加锁，属产品策略问题：**要求"所有状态文件一律跨进程串行"**则全加；
> **只要"会累积条目"的存储加锁**则维持现状。需用户裁决。

## D. 已验证的真实进程行为

| 验证 | 命令 | 结果 |
|---|---|---|
| 两个**真进程**并发更新任务链 | `npm run verify:cross-process-lock` | `revision=41`（无丢更新） |
| tarball 隔离安装 | `npm run verify:tarball-install` | 安装后 CLI 输出版本号 |

## E. 2026-11-18 收尾状态

C1（累积型且无 CAS 的存储）**已全部接入文件锁**，A 类共 **18 处**，每处都有"摘掉锁会红"的反例：

`task-store`、`coordination-task-application-ledger`、`context-admission`、`mailbox-journal`、
`artifact-record-store`、`mission-task-sequence-map-store`、`comm-delivered-message-store`、
`deferred-insertion-queue`、`mission-sequence-binding-store`、`mission-relation-index`、
`context-recall-ledger-store`、`coordination-submission-identity`、`coordination-retry-store`、
`goal-requirement-mapping-store`、`prompt-scan-journal-store`、`task-ledger-divergence-journal`、
`goal-dispatch-verdict-journal`、`remote-delivery-outbox`。

**仍待用户裁决**：C2（17 处单文档整写）是否也统一加锁。

## F. §36.1 C2 逐项审计（2026-11-18）

按 §36.1 要求展开：每个实际存储一行。**读者/用途**取该存储自身的导入点与职责说明；
**判定**按 §36.2：默认按权威状态处理，只有能证明"可重建的展示快照"才允许最后写入者胜。

| # | 存储键（文件） | 生产写入口 | 读者与用途 | 覆盖策略 | 已有保护 | 测试/调用点 | §36 判定 |
|---|---|---|---|---|---|---|---|
| 1 | `goal-mode/<goal>.json` | `GoalModeStateStore.write` / `beginTaskGroup` / `finishTaskGroup` | `application-runtime`、目标门禁缓存：决定目标是否激活与任务组状态 | 整文档覆盖 | 进程内互斥 | 目标模式相关测试 | **权威**：激活状态丢更新会改变执行资格 |
| 2 | `goal-mode/contracts/<goal>.json` | `GoalContractStore.save` / `saveActivated` | `application-runtime`、目标门禁：契约 revision 与验收要求 | 整文档覆盖 | 无 | 目标契约测试 | **权威**：契约 revision 决定验收判定 |
| 3 | `goal-mode/proposals/<goal>.json` | `GoalContractProposalStore.save` | `application-runtime`、契约提案流程 | 整文档覆盖 | 无 | 提案测试 | **权威**：提案被旧值覆盖会丢失待裁决项 |
| 4 | `goal-mode/mission-bindings.json` | `GoalMissionBindingStore`（写入方法未在扫描中命中，需在实施时补读） | `application-runtime`、门禁缓存：mission↔目标归属 | 单文档累积 | 无 | 目标绑定测试 | **权威**：归属错乱会错判任务所属目标 |
| 5 | `startup-recovery/policy.json` | `StartupRecoveryPolicyStore.writePolicy` | `application-runtime`、启动恢复：恢复策略（用户策略） | 整文档覆盖 | 无 | 启动恢复测试 | **权威**：覆盖用户策略 |
| 6 | `startup-recovery/last-report.json` | `StartupRecoveryReportStore.writeReport` | `application-runtime`：上次恢复结果展示 | 整文档覆盖 | 无 | 启动恢复测试 | **待证快照例外**：需证明"可由重跑恢复生成"，否则按权威 |
| 7 | `startup-recovery/attempts.json` | `StartupRecoveryAttemptStore.recordAttempt` / `resetAttempt` | `application-runtime`：恢复尝试计数（决定是否再试） | 单文档累积 | 无 | 启动恢复测试 | **权威**：计数丢失会无限重试或不再重试 |
| 8 | `conversation-identity/conversations.json` | `ConversationIdentityStore.beginRun`（`writeDocument`） | `application-runtime`、`main-controller`：会话↔运行登记 | 单文档累积 | 无 | 会话身份测试 | **权威**：身份/归属记录 |
| 9 | `agent-memory/**/edit-intent*.json`（由 `AgentEditIntentGuard` 构造） | `recordReadBaseline` / `recordOwnWrite` | `application-runtime`：读基线/自写判定（防越权改他人内容） | 按个体分文件 | 无 | 守卫测试 | **权威**：基线被旧值覆盖会让越权写入被误判合法 |
| 10 | `collaboration/cross-project-ledger.json` | `sendCrossProjectMessage`（`writeAtomicJson`） | 跨项目协作：发送账本与去重 | 单文档累积 | 无 | 跨项目协作测试 | **权威**：丢失会让同一消息被重复发送 |
| 11 | `completion-receipts/**` | `CompletionReceiptStore.save` | `main-controller`、`mission-orchestrator`：完成收据（门禁依据） | 按任务分文件 | 无 | 完成门禁反例 | **权威**：收据即完成证明 |
| 12 | `completion-verdicts/**` | `CompletionVerdictStore.save` | `main-controller`、验收/目标要求评估：独立验收裁决 | 按任务分文件 | 无 | ALIGN-03 反例 | **权威**：裁决逆转会改变 accepted/rework |
| 13 | `work-window/deferred-missions.json` | `WorkWindowDeferredMissionStore.record` | `application-runtime`：工作时段外推迟的 mission | 单文档累积 | 无 | 工作时段测试 | **权威**：丢记录 ⇒ 推迟任务永不执行 |
| 14 | `tool-packages/lifecycle.json` | `ToolPackageLifecycleService.persist` | `application-runtime`：工具包生命周期状态 | 整文档覆盖 | 无 | 工具包测试 | **权威**：生命周期逆转会放行已停用包 |
| 15 | `tool-packages/**`（操作反馈） | `ToolPackageOperationFeedbackStore.appendRecord` | `public-sdk`：工具包操作反馈 | 追加 | 无 | 工具包测试 | **权威**：追加丢失 ⇒ 操作无审计 |
| 16 | `tool-packages/**`（版本状态） | `ToolPackageVersionStateStore.saveController` | `public-sdk`：版本选择控制 | 整文档覆盖 | 无 | 工具包测试 | **权威**：版本控制状态 |

> 说明：第 6 行是唯一可能属于"可重建展示快照"的候选，但 §36.2 要求**证明**可重建且无执行/授权/恢复决策依赖；
> 本轮未证明，因此**按权威处理**（与其它行同等对待）。

## G. §36.2–36.4 实施状态（2026-11-19）

**§36.1 已完成；§36.2 已完成 1/15，§36.3 已完成 1 处**。具体：`goal-mode` 已实现 `writeIfDocumentRevision`（文件锁内重读 + 预期版本校验 + 冲突显式返回），`beginTaskGroup`/`finishTaskGroup`/`closeExperiment` 全部改走 CAS；反例见 `tests/core/integration/goal-mode-stale-write.test.ts` 与 `npm run verify:two-process-stale-write`（真两进程场景 2）。\n\n以下仍未实施：

- §36.2 默认防陈旧写入：为上表"权威"行加"跨进程临界区 + 预期版本校验 + 合法迁移校验"；
- §36.3 不可变回执的原子首次创建语义（同键同内容复用、同键异内容拒绝）；
- §36.4 两个独立 OS 进程 + IPC 消息控制的反例（A 读、B 提交、A 提交旧值 ⇒ A 被拒且状态为 B 的）。
