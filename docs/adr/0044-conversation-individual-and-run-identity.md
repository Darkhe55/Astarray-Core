# ADR-0044 会话、个体与运行的身份分层（ALIGN-01 前置）

- 状态：已采纳（契约层 + 生产装配）
- 日期：2026-10-28
- 来源：[ALIGN-01](../tasks/ALIGN01_IDENTITY_AND_MAIN_AGENT.md) 检查点 01
- 相关：ADR-0013（任务偏序集）、ADR-0021（主 Agent 只读投影）、ADR-0034（摘要清单）

## 1. 背景

ALIGN-00 的静态基线指出：`main-controller.handleUserMessage` **每条用户消息都新建 mission**，
而 ponder 路径每次生成 `main:ponder:<随机>`。于是“会话”“个体”“运行”“任务”四个概念被压成一层：

- 没有稳定的会话实体 ⇒ 重启后无法回答“这条新消息属于哪个会话/哪个主个体”；
- 个体标识随调用变化 ⇒ 个体记忆、读取抑制账本、汇报来源**都没有稳定归属**；
- `missionId` 被当成会话与运行使用 ⇒ 历史视图、恢复对账只能按任务 id 猜。

本 ADR 冻结**最小身份分层**：只补一层持久映射，不新建第二套调度，也不改变 mission 的语义。

## 2. 标识分层（冻结）

| 标识 | 语义 | 生命周期 | 谁生成 |
| --- | --- | --- | --- |
| `projectIdentifier` | 工程归属（与 `registeredProjectRoots` 同源） | 长期 | 装配/用户 |
| `conversationIdentifier` | **稳定会话**：跨消息、跨重启 | 直到显式关闭 | 存储层（`conversation-<uuid>`）或调用方显式给出 |
| `mainAgentInstanceIdentifier` | 该会话选定的**主 Agent 个体**（记忆键精确到它） | 随会话 | 存储层（`main-agent-<uuid>`）或装配层已有可信 id |
| `runIdentifier` | 一次执行（一次应答/一次派发） | 单次，永不复用 | 存储层（`run-<uuid>`） |
| `missionIdentifier` | 本次执行的**任务投影** | 单次 | 现有 `mission-<8hex>`（不变） |

`runIdentifier` 与 `missionIdentifier` **各自独立**：run 可以没有 mission（纯问答），
mission 也可以被同一 run 覆盖（重放时同一 mission 返回同一 run，不重复登记）。

## 3. 四条不变量（由代码强制）

1. **不以宿主进程/任务冒充会话**：会话与主个体标识命中 `mission-*`、`pid:*`、`process-*`、`host:*`
   形态一律 `conversation-identity-conflict`（`isDerivedProcessOrMissionIdentifier`）。
2. **不按角色名猜归属**：同一 `conversationIdentifier` 绑定了别的项目 ⇒ 冲突；
   命中已登记会话时**沿用其登记过的主个体**，不拿本进程 id 改绑（改绑只发生在显式 `openConversation`，
   参数不符即冲突）。
3. **关闭即终止**：已关闭会话拒绝继续登记运行（`conversation-identity-closed`），
   要继续必须开**新**会话 ⇒ **新个体**，不继承旧记忆。
4. **无项目不记账**：没有 `projectIdentifier` 的消息不写会话映射（宁可不记，也不挂到默认项目上）。

## 4. 存储与错误码

- 文件：`<stateDirectory>/conversation-identity/conversations.json`（+ `.bak`）
- 纪律：原子替换、写前备份、坏文件从备份恢复、`revision` 单调递增、并发写用互斥；
  每个会话最多保留 200 条运行记录，溢出丢弃最旧并**如实累计** `droppedRunCount`（不静默丢）。
- 新增稳定错误码（`packages/core/src/core/errors.ts`）：
  `conversation-identity-not-found` / `conversation-identity-closed` / `conversation-identity-conflict`。

## 5. 生产调用链（源码位置）

```
用户消息
└─ MainController.handleUserMessage                 packages/core/src/orchestration/main-controller.ts
   ├─ resolveConversationIdentityForMission          同文件（解析/开新会话；无项目 ⇒ null）
   │  └─ ConversationIdentityStore                   packages/core/src/orchestration/conversation-identity-store.ts
   │     ├─ resolveOrOpenConversationForProject      权威存储：项目 → 会话 → 主个体
   │     └─ beginRun                                 run 登记（按 mission 幂等）
   ├─ MissionManager.createMission                   packages/core/src/orchestration/mission-manager.ts
   │  └─ summary.conversationIdentifier              历史视图可读的会话投影
   └─ getMissionConversationIdentifier               mission → 会话 只读查询
装配
└─ application-runtime                              packages/core/src/application/application-runtime.ts
   ├─ conversationIdentityStore = new ConversationIdentityStore({ baseDirectory: stateDirectory })
   ├─ 缺省启用；isConversationIdentityEnabled === false ⇒ 不构造（回到旧行为）
   └─ 透传 mainAgentInstanceId（state-dir 派生，跨重启稳定）
```

## 6. ponder 路径（ALIGN-01-02，2026-10-28 追加）

`MainController.respondInPonderMode` 不再每次生成 `main:ponder:<随机>`：

1. 有会话映射 ⇒ 用该会话**登记过的**主个体（不按角色名猜、不新建）；
2. 无映射但装配层给了稳定 `mainAgentInstanceId` ⇒ 用它；
3. 两者都没有 ⇒ 才退回本次调用临时 id（旧行为，且明确是兜底而非默认）。

每次 ponder 调用都会登记一条**无 mission 的 run**（`beginRun` 不传 `missionIdentifier`），
因此“持续追问”表现为同一会话、同一主个体、多条 run —— 这正是 ALIGN-01 要求的
“一次会话选择既有主个体，新调用仅新建 run”。

## 7. 未完成（明确不算本 ADR 已交付）

- **主 Agent 提案控制面**（ALIGN-01-03/04）与**报告索引来源**（ALIGN-01-06）尚未接到本映射。
- **重启恢复**（ALIGN-04-01/02）尚未消费该映射做对账。
- 显式直投路径尚未写入同一会话，仍是独立入口。
- 旧身份映射的迁移规则（ALIGN-01-07）尚未实现（只保证新链路不再造随机个体）。

## 8. 验证状态

**implemented-unverified**。本检查点按任务卡口径**未编写/未运行测试**，也未做人工验收。
已执行且通过的只有编译/静态门禁：`npm run typecheck`（exit 0）、
`npx eslint <本批改动文件>`（exit 0）。**不得据此宣称“身份恢复已验证”**。
