# COORD-04：协作收件箱只读读取出口（跟随任务列表统一读取）

**状态**：`implemented`（有反例；全量门禁见文末）
**立卡**：2026-11-21
**来源**：用户裁决 A —— "协作消息应该也根据任务列表的统一读取调用出口调用"。
**相关**：COMM-01（寻址/转达）、COORD-01（准入 ≠ 投递）、COORD-02（授权章与投递复核）、
ADR-0060（反馈 outbox 补送；永久拒绝分类见其 §6）。

## 1. 裁决与目标

- 协作请求**不再只靠"推"**进上下文：Agent 读取任务列表时，从**同一个出口**读到待处理协作请求；
- 读取必须**只读**：不投递、不确认、不改变四态机；
- 身份由 harness 注入（模型不能自报他人身份读别人的箱）；
- 只返回**授权复核通过**的请求；未通过的如实计数，不静默；
- 分页稳定：按 `receivedAtIso + messageIdentifier` 排序，游标不重不漏。

## 2. 设计（为什么接 `taskSequenceStatus`）

| 备选 | 结论 |
|---|---|
| 扩 `taskSequenceStatus` 快照 | **采用**：它就是 Agent 读取"我该干什么"的唯一只读出口（身份 harness 注入、只读、无副作用），与"任务列表"语义一致 |
| 给 `readFile` 加 action | 否：`readFile` 是文件内容读取；协作请求不是文件，硬塞会让族语义分叉 |
| 新造一个独立工具 | 否：违背 MERGE-01 "以能力族 + action 复用现有工具，不另造一套名字" |

副作用约束：读取路径**不调用** `deliverWithAuthoritativeAuthorization`（它会 `recordDeliveryFailure`），
而是用同规则的新纯判定 `evaluateAuthoritativeAuthorization`（只读、不改状态）。

## 3. 实现

| 层 | 位置 | 内容 |
|---|---|---|
| 只读视图（纯函数） | `packages/core/src/orchestration/collaboration-inbox-read.ts` | `buildPendingCollaborationView`：身份过滤 → 只取 `received` → 授权集合过滤 → 稳定排序 → 分页/游标；投影只含标识/归属/摘要，**不含正文** |
| 只读授权判定 | `packages/core/src/orchestration/collaboration-authoritative-delivery.ts` | 抽出 `evaluateAuthoritativeAuthorization`（缺章/查不到/撤销/旧代/代 0 一律不通过），投递复核改为复用它（行为不变） |
| 生产读取端口 | `collaboration-inbox-read.ts` | `createCollaborationInboxReadPort`：读收件箱文件（不存在 ⇒ 空视图；损坏 ⇒ `isAvailable:false`，不伪装成"没有消息"）→ 逐条只读复核 → 构造视图 |
| 工具出口 | `packages/core/src/tools/builtins.ts`（`taskSequenceStatus`） | 新增可选参数 `collaborationPageSize`（1..50）、`collaborationCursor`；装配端口时输出 `pendingCollaboration`；未装配时**不输出该字段**（旧行为不变）；单条读取失败只降级该字段，不影响任务快照 |
| 装配 | `application-runtime.ts` | 构造收件箱商店 + 权威授权商店 + 读取端口，随 `taskSequenceStatusController` 一起注入 `PolicyWrapper`（同时补上此前未接的序列状态控制面） |
| SDK | `public-sdk.ts` | 导出读取端口/视图/常量与 `FeedbackMessageRejectedError`（宿主可自建读取入口） |

## 4. 反例（先写后实现）

| 文件 | 用例 |
|---|---|
| `tests/core/unit/collaboration-inbox-read.test.ts` | ① 身份隔离 + 只取 received；② 未授权跳过并计数；③ 排序/分页游标不重不漏；④ 投影不含正文/载荷；⑤ 页大小规范化（0⇒1，500⇒50）；⑥ 真实存储：有章可见、无章跳过、**读两次状态仍是 received 且交付尝试 0**；⑦ 收件箱损坏 ⇒ 明确不可用 |
| `tests/core/unit/task-sequence-controllers.test.ts` | 工具层：装配端口 ⇒ 同一出口返回 `pendingCollaboration`、身份与页大小透传；未装配 ⇒ 不输出字段；非法页大小 ⇒ 明确拒绝 |

## 5. 边界（不做的事）

- **读取 ≠ 投递 ≠ 确认**：不 `markDelivered`、不推进状态、不写交付回执；
- 不返回消息正文/产物引用列表，只给摘要与标识（正文要走显式回访/投递链路）；
- 不替代权限/范围门禁（投递时仍走 COORD-02 的权威复核）；
- 未做：跨进程读取性能实测、TUI/GUI 展示、按任务过滤的读取视图。

## 6. 门禁

定向：`collaboration-inbox-read` 7 条 + 工具层 1 条 + 既有投递复核回归 6 条全部通过；
`typecheck` exit 0、`lint` exit 0。

本机全量：**868 files（863 passed / 3 failed / 2 skipped），5572 tests（5562 passed / 3 failed / 7 skipped），exit 1**。
3 条失败均为已在基线 HEAD 复现的本机环境问题（Windows 创建符号链接 ×2、无隔离执行后端 ×1），与本次改动无关。

**未做（如实）**：应用装配层的**产品路径证据**（经完整 runtime 捕获"模型请求里读到协作请求"）；
本卡证据止于工具执行上下文与读取端口本身。阻塞原因见 §7。

## 7. 产品路径证据：阻塞（需夹具/契约裁决）

尝试用既有产品路径夹具（facade → orchestrator → worker → 捕获请求）证明"模型请求里读到协作请求"，被两个**夹具事实**挡住：

1. `submitTask` **不创建** Agent 待办序列 ⇒ worker 上 `taskSequenceStatus` 的 `sequenceId` 无对应快照
   （会先 `task-sequence-not-found`，读不到协作段）；
2. worker 个体标识是 `worker:<missionId>:<taskId>:<counter>`，`counter` 在运行时分配
   ⇒ 无法在首次请求前把协作消息种进该收件人的收件箱（不猜身份就无法在两次请求之间插入种子）。

⇒ 需要裁决：要么规定"worker 序列由谁、何时创建"，要么提供"按 mission 解析本轮 worker 身份"的权威读取口。
不属于本卡可自行决定的范围，故此处**停在阻塞点**。

## 8. 死信人工入口（同日补，用户裁决 C）

| 能力 | 位置 |
|---|---|
| 死信存储（list/read/requeue/remove；文件名只接受 64 位哈希 `.json`；坏文件如实计数） | `packages/core/src/feedback-process/dead-letter.ts` |
| CLI | `astarray feedback-outbox list|requeue|remove`（`list` 同时显示补送积压） |
| 计数 | `ForkFeedbackClient.getOutboxStatus()` → `{ pendingCount, deadLetterCount }` |
| 反例 | `feedback-dead-letter-store.test.ts`（5 条）+ `feedback-outbox-command.test.ts`（4 条） |

纪律：`requeue` **原样**写回（不改内容）；已在补送队列 ⇒ `already-queued` 不重复写；非法文件名 ⇒ 退出码 2。
