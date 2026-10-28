# ADR-0060 反馈消息幂等入库与本地补送（ALIGN-03-06）

- 状态：部分采纳（幂等入库 + 客户端 outbox 已接；重试上限与可观测未做）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 06
- 相关：ADR-0047（报告索引，不自动注入明细）、`FeedbackProcessSupervisor`

## 1. 背景

卡内要求：反馈保留**独立进程生产路径**、来源个体与目标标识；消息**幂等入库**，
传输失败**可补送**；次级向主 Agent 报告摘要引用、主侧归档，**不自动注入全部明细**。

实测：

- 独立进程路径**已存在**：`FeedbackProcessSupervisor` fork 子进程，`ForkFeedbackClient`
  经 IPC 通信；子进程有 `MailboxJournal`（持久化 + `peekNext` 重放）与 `DeliveryWorker`。
- **缺口 1（幂等入库）**：`MailboxJournal.enqueue` 直接 `push`，**不按 `idempotencyKey` 去重**
  —— 同一消息重发（崩溃恢复、补送）会入库两次并投递两次。
- **缺口 2（可补送）**：客户端 `enqueue` 只在内存里发一次请求；子进程崩溃/超时会直接拒绝，
  **消息丢失**（子进程侧的 journal 只覆盖"已入库"之后的重放）。
- 摘要引用/不自动注入：ALIGN-01-06 已实现（报告索引只读、`context-prompt-assembler` 无报告引用），
  本检查点未改动。

## 2. 契约（冻结）

1. **先落盘、后发送、ack 后删除**：客户端在发 IPC 之前把消息原子写入
   `<stateDirectory>/feedback-client-outbox/<sha256(idempotencyKey)>.json`；收到子进程 ack 后删除。
   连"子进程还没就绪"的失败也能补送。
2. **补送触发**：`flushPendingOutbox()` 由 supervisor 的**心跳**顺带调用；
   单条失败不中止其余条目（各自保留，下次再试）。
3. **不静默删现场**：损坏的 outbox 文件**保留**（不删除、不当成功），继续计为未发送。
4. **幂等入库**：`MailboxJournal.enqueue` 按 `idempotencyKey` 去重 ——
   同键同内容 ⇒ 返回既有序列号、**不追加**；同键异内容 ⇒ `operation-not-idempotent`（拒绝覆盖）。
5. **"内容"口径**：比较来源、目标、优先级与 payload；刻意排除 `messageId` 与 `createdAtIso`
   （重发可能带新 id/时间戳）。
6. **身份与目标不变**：消息的 `source`（含具体 `agentInstanceId`）与 `recipientId` 原样保留，
   补送**不改造**来源。

## 3. 生产调用链（源码位置）

```
AgentRuntime/编排 enqueue(message)
└─ ForkFeedbackClient.enqueue                       packages/core/src/feedback-process/transport.ts
   ├─ persistOutboxMessage（原子写 + 幂等键哈希文件名）
   ├─ IPC { type: "enqueue" } → 子进程 entrypoint.ts handleEnqueue
   │  └─ MailboxJournal.enqueue                    packages/core/src/feedback-process/mailbox-journal.ts
   │     └─ 幂等键去重（同内容返回旧序列 / 异内容拒绝）
   ├─ ack → removeOutboxMessage
   └─ 失败 → 保留文件（消息不丢）
supervisor 心跳
└─ ForkFeedbackClient.flushPendingOutbox             process-supervisor.ts startHeartbeatLoop
   └─ 逐条重发（子进程幂等去重）
```

## 4. 未完成（如实）

- **补送无上限/无退避**：每次心跳都会重试，失败消息可能被无限重试（虽然幂等、
  但会持续占用 IPC）；没有"超过 N 次转人工"的路径。
- **可观测性不足**：`flushPendingOutbox()` 返回计数，但没有任何 UI/日志消费它；
  积压条数不可见。
- **无 outbox 清理策略**：损坏文件会永久滞留。
- **未验证**：没有跑过"发送失败 ⇒ 文件保留 ⇒ 心跳补送 ⇒ 只入库一次"、
  "同键异内容 ⇒ 拒绝"任何一条；也没有做过子进程崩溃恢复实测。
- 摘要引用/不自动注入依赖 ALIGN-01-06 的既有实现，本轮未重新验证。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
