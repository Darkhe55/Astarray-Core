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

本机全量：**871 files（865 passed / 4 failed / 2 skipped），5582 tests（5571 passed / 4 failed / 7 skipped），exit 1**。
4 条失败 = 3 条已基线复现的本机环境问题（Windows 符号链接 ×2、无隔离执行后端 ×1）
\+ 1 条已知负载抖动（`graph-change-deterministic-drill`，隔离复跑 **3/3 通过**）。

**未做（如实）**：其它读取入口（无序列时如何拉取协作请求）尚无裁决；TUI/GUI 展示与按任务过滤的读取视图未做。
产品路径证据见 §7（已有反例）。

## 7. 产品路径证据（2026-11-21，按用户裁决）

**裁决**：worker 的任务序列**由上级 agent 或用户按需创建**——`submitTask` 不自动建序列。

**证据**：`tests/core/integration/coord04-collaboration-read-product-path.test.ts`，走**真实装配链路**
（`AstarrayApplicationFacade` → `MissionOrchestrator` → `WorkerAgent` → 假 Provider **捕获请求体**）：

1. 首次请求时按裁决以**用户身份**为 worker（`worker:<missionId>:<taskId>:1`）创建序列，
   并种入一条已授权的协作请求（权威授权存储 + 收件箱文件）；
2. 假 Provider 返回 `taskSequenceStatus` 工具调用 → 真实权限/执行 → 结果回填；
3. **第二次请求体**里的工具结果含 `pendingCollaboration.isAvailable=true`、消息标识与摘要，
   `readOnlyNotice` 明确"读取不改变消息状态"；收件箱状态仍为 `received`、交付尝试 **0**。

**由此裁决直接推出的边界**：**没有序列的 worker 读不到协作段**（工具先取序列快照）。
这符合"按需创建"——没有任务清单的个体不承担"读任务列表"的职责；发给它的协作消息仍可经
**投递链路**推送。若产品希望"无序列也能拉取协作请求"，需要另立读取入口（不在本卡默认行为内）。

## 8. 死信人工入口（同日补，用户裁决 C）

| 能力 | 位置 |
|---|---|
| 死信存储（list/read/requeue/remove；文件名只接受 64 位哈希 `.json`；坏文件如实计数） | `packages/core/src/feedback-process/dead-letter.ts` |
| CLI | `astarray feedback-outbox list|requeue|remove`（`list` 同时显示补送积压） |
| 计数 | `ForkFeedbackClient.getOutboxStatus()` → `{ pendingCount, deadLetterCount }` |
| 反例 | `feedback-dead-letter-store.test.ts`（5 条）+ `feedback-outbox-command.test.ts`（4 条） |

纪律：`requeue` **原样**写回（不改内容）；已在补送队列 ⇒ `already-queued` 不重复写；非法文件名 ⇒ 退出码 2。

## 9. 生产发送入口（2026-11-21，用户确认推荐方案）

**形态**：应用门面 `sendCollaborationRequest` + CLI `collaboration send`，共用同一核心实现；
Agent 工具作为**第二阶段**（需先定角色/审批策略），本卡不做。

**同项目关系**：首次发送**自动登记默认关系**（`relationshipKind: "local-default"`，epoch=1）——
这是"登记关系"供代际检查，不是逐边审批；用户/上级可撤销，撤销后**不自动复活**。
跨项目仍必须显式授权，并核对收件人/项目范围。

**入口规则（全部 fail-closed）**：

| 规则 | 结果 |
|---|---|
| 收件人未登记 / 已回收 | `recipient-not-a-known-agent` |
| 发给自己 | `self-addressed` |
| 三级/四级发给非直属上级 | `relay-required`（附上级标识） |
| 跨项目缺授权 / 查不到 / 撤销 / 越界 | `authorization-missing` / `authorization-revoked` / `authorization-scope-mismatch` |
| 同项目关系已撤销 | `authorization-revoked`（不复活） |
| 同一 `requestIdentifier` 重发 | `duplicate`（复用同一 `messageIdentifier`） |
| 收件箱损坏/并发冲突 | `inbox-unavailable` / `inbox-rejected` |

**实现位置**：

| 层 | 位置 |
|---|---|
| 核心服务（五步：地址 → 层级 → 授权 → 入箱持久化 → 投递） | `packages/core/src/orchestration/collaboration-request-service.ts` |
| 默认关系自动登记 | `cross-project-authorization-store.ts` 的 `ensureLocalCollaborationRelationship` |
| SDK 门面 | `public-sdk.ts` `AstarrayApplicationFacade.sendCollaborationRequest` |
| CLI | `astarray collaboration send --from --to --task --summary [--scope --authorization …]` |

**反例**：`collaboration-request-send.test.ts`（7 条：同项目自动关系/跨项目授权/地址完整性/自我发送/三级转达/幂等/撤销不复活）
\+ `collaboration-send-command.test.ts`（3 条：成功落盘/未知收件人/幂等 duplicate）。

**仍未做**：Agent 工具入口（角色/审批/频率策略待定）；跨项目真实网络通道（此前已定本机状态）。
