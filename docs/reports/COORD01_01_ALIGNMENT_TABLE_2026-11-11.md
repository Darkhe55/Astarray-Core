# COORD-01-01 对账表与信封/三状态冻结（2026-11-11）

依据卡：`docs/tasks/COORD01_TASK_FEEDBACK_CONSUMPTION_REPAIR.md`。
本文件只做**原接口 → 生产调用方 → 持久状态 → 消费方**的对账，以及信封与三状态的现状冻结；
**不做实现**（实现属 COORD-01-02/03）。所有结论附源码证据，不做推断。

## 1. 接口 → 调用方 → 持久状态 → 消费方

| 环节 | 现有实现 | 生产调用方 | 持久状态 | 消费方 |
|---|---|---|---|---|
| 消息入队（可靠入库） | `feedback-process/mailbox-journal.ts` `enqueue`（幂等入库：`idempotencyKey`，同键异内容拒绝） | `main-controller.sendSchedulerInstruction`（`feedbackTransport.enqueue`） | `MailboxJournalDocument`：`recipientId`、`nextSequence`、`messages[]`；单条仅 `enqueuedSequence` / `delivered` / `deliveredAtIso` | `feedback-process/entrypoint.ts`、`delivery-worker.ts` |
| 投递 | `delivery-worker.runDeliveryStep`：`peekNext` → 收件人非 idle ⇒ `recipient-busy` + 素数退避 | 反馈进程主循环 | 同上（`delivered` 布尔 + `deliveredAtIso`） | `AssistScheduler`（`assist-scheduler.ts:57` 收到消息后调 `handleInstruction`） |
| 协作消息 | `orchestration/collaboration-inbox.ts` `enqueue`（按 `messageIdentifier` 判重、复用回执、`duplicateDeliveryCount`） | `collaboration-feedback-mapping.ts` 映射进反馈通道 | `CollaborationInboxMessage`：`state`（received/…）、`deliveryAttemptCount`、`lastFailureAtIso`、`authorizationEpoch` 等 | 收件箱查询与视图 |

## 2. 信封现状 vs 卡内要求的规范信封

| 卡要求字段 | 现有 `FeedbackMessage`（`core/types.ts`） | 结论 |
|---|---|---|
| `messageIdentifier` | `messageId` | ✅ 有（命名待统一） |
| 来源（可信用户/系统或 agent 个体） | `source: { sourceType, sourceIdentifier }` | ✅ 有 |
| `recipientAgentInstanceIdentifier` | `recipientId`（协作消息用 `agent:<id>` 前缀，`fromCollaborationRecipientId` 反解） | ⚠️ 有值但**是字符串约定**，非结构化标识 |
| `projectIdentifier` | **不在 `FeedbackMessage` 信封**；但已有先例：`TaskBundleDispatchEnvelopeRecord.projectBoundary.projectIdentifier`（`core/types.ts:709`） | ❌ **缺失**：跨项目分区键（卡 §4.1 要求 项目 ID + 调度 Agent 个体 ID）目前无法从反馈信封取得；实现可复用上述任务包信包的 `projectBoundary` 口径 |
| `taskIdentifier` | **不在信封**，只在 `payload` 的 `collaboration-request` 变体里 | ❌ **缺失**：普通指令/状态消息没有任务标识 |
| 幂等键 | `idempotencyKey`（主控指令已改为由 `messageId` 决定，见 `main-instruction-identity.ts`） | ✅ 有 |

## 3. 三消费状态现状

| 状态 | 现状 | 证据 |
|---|---|---|
| **deliveryState** | 只有布尔 `delivered` + `deliveredAtIso` | `mailbox-journal.ts` `JournaledMessage` |
| **applicationState**（pending / applied / ignored-stale / blocked / rejected） | **不存在** | 全仓库无该字段；收件箱的 `state` 属**投递/处理**粗粒度，不区分"已应用"与"已投递" |
| **contextDeliveryState**（not-required / pending / delivered / unknown） | **不存在** | 无字段；`delivered 只代表模型请求已携带` 的区分当前无处记录 |

⇒ 卡内"禁止用一个 `consumed` 布尔值同时代表上述状态"这一条：**现状更差**——只有一个 `delivered` 布尔，
既没有 application 也没有 context 维度。

## 4. 产物引用状态（本卡 §3 相关）

- `artifactReferenceStatus: "provided" | "not-provided"` 已加入消息与反馈载荷（2026-11-11），
  空数组亦记 `not-provided`；
- 卡内"需要产物证明的审查/完成门禁不能凭缺失引用通过""有引用须核对实际版本"**均未实现**，
  现仅有"携带与校验"，无"核对实际版本"。

## 5. EVENT 卡冲突核实

**产品侧确认（2026-11-11）**：EVENT 指的就是下面这 4 张卡，不是另一份独立文档。

- `docs/tasks/2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS.md`
- `docs/tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md`
- `docs/tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md`
- `docs/tasks/ALIGN04_RECOVERY_AND_STATUS.md`

**范围声明（双仓库纪律）**：本仓库只记录**公开仓库内**的 EVENT 描述。若 EVENT 相关材料另有存放在私有仓库中的部分，
本文件**不引用、不复制、不指向**——避免把私有内容混入公开仓库。因此上表只以这 4 份公开文档为核对依据。

## 6. 结论与后续

1. COORD-01-01 的对账部分**已可交付**：缺口集中在 ①信封缺 `projectIdentifier` / `taskIdentifier`；
   ②三状态只剩一个 `delivered` 布尔；③产物版本核对未实现。
2. 这些缺口正是 COORD-01-02/03 的实现范围，本文件**不改代码**，避免与卡内顺序（01→02→03→04）冲突。
3. 待确认：EVENT 卡具体指哪一份文档（见 §5）。
