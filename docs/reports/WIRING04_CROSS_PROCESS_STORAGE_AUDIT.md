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

- `goal-requirement-mapping-store`
- `coordination-retry-store`
- `coordination-submission-identity`
- `context-recall-ledger-store`
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
