# ADR-0045 主 Agent 的任务提案边界（只读工具 + 本地提案控制面）

- 状态：已采纳（契约层 + 生产接线）
- 日期：2026-10-28
- 来源：[ALIGN-01](../tasks/ALIGN01_IDENTITY_AND_MAIN_AGENT.md) 检查点 03
- 相关：ADR-0013（任务偏序集）、ADR-0021（主 Agent 只读投影）、ADR-0022（任务插入提案）、ADR-0044（身份分层）

## 1. 背景

ALIGN-01 要求：默认用户对话进入**主 Agent 交流与高层评估**；主 Agent 在**全部权限模式**下
只暴露读取工具；任务只能经**既有本地提案控制面**提交，模型不能直接 spawn、执行、写盘，
也不能填写认证/授权字段。

现状核对（本轮实测）：

- `MainAgentReadonlyToolProjection`（ADR-0021）已存在，`MainController.getMainAgentToolProjection`
  已按它投影；
- 但 ponder 的工具面**只看 `PONDER_READONLY_TOOL_NAMES`**，不看投影 ⇒ 两处白名单可以漂移，
  投影再严格也管不到 ponder；
- `ConversationTaskInsertionController`（ADR-0022）已能校验来源/优先级/锚点/revision，
  但**没有面向主 Agent 的入口**：谁都不能保证"模型提交的字段里没有伪造来源"。

## 2. 契约（冻结）

主 Agent 能产出的**唯一**东西是结构化提案，字段严格限定为：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `targetSecondaryAgentInstanceIdentifier` | 是 | 次级个体；不得等于来源个体 |
| `sequenceIdentifier` | 是 | 目标次级已存在的任务序列 |
| `expectedRevision` | 是 | ≥ 0 整数（观察到的 revision；不匹配由序列层拒绝） |
| `title` | 是 | 非空 |
| `acceptanceCriteria` | 是 | 非空（验收条件，不是"已完成"声明） |
| `predecessorTaskIdentifiers` / `successorTaskIdentifiers` | 否 | 字符串数组；同一任务不得同时是前驱与后继 |
| `userTaskReference` | 是 | **必须等于**本次用户消息引用（harness 注入） |
| `priorityTier` | 否 | 必须 ≥ 1（Agent 来源不得进用户层级 0） |
| `requiredArtifactIdentifiers` | 否 | 字符串数组，≤ 50 项且不得重复；**只声明"要产出什么"，不证明已产出** |

**拒绝规则**（全部 fail-closed，不做"尽力猜测"）：

1. **未知字段**一律拒绝（`invalid-task-chain`）——模型不能借多写字段塞入别的东西；
2. **身份/授权字段**（`sourceKind`/`sourceActorId`/`authenticatedUserId`/`approvedBy`/
   `authorization`/`permission`/`userDecisionReference`/`signature`/`token` …）一律
   `task-sequence-permission-denied` —— 这些只能由 harness 注入；
3. 来源恒为 `agent`、来源个体由装配层给出；模型提供的值**完全不参与**；
4. 提案引用与本次用户消息不一致 ⇒ 拒绝（不得凭空发明"用户任务"）；
5. 来源个体无法确定（既无会话登记也无装配 id）⇒ 拒绝，**不以匿名来源提交**；
6. 目标个体等于来源个体 ⇒ 拒绝（主 Agent 不能把任务投给自己）。

**不重复实现**：revision 校验、锚点合法性、优先级策略、序列变更备份仍由
`ConversationTaskInsertionController` → `TaskSequenceManageController` → `AgentTaskSequenceStore`
负责。本 ADR 只在它们之前加一道"模型字段 vs 本地身份"的边界。

## 3. 只读工具面：单一权威

- `MainAgentReadonlyToolProjection` 是主 Agent 工具面的**唯一权威**；
- ponder 白名单必须**是它的子集**：装配期检查，违反即 `createApplicationRuntime` 失败
  （不允许"先跑起来再说"）；运行时过滤条件也加上投影判定；
- 因此新增工具若不在投影内，**不可能**通过 ponder 名单泄露给主 Agent。

## 4. 生产调用链（源码位置）

```
用户消息
└─ MainController.handleUserMessage                       packages/core/src/orchestration/main-controller.ts
   ├─ rememberUserMessageReference（harness 生成 user-message-<uuid>，模型不可填）
   └─ beginRun({ userMessageReference })                  持久化到会话运行记录
主 Agent 提案（模型输出 JSON，非工具调用）
└─ MainController.submitMainAgentTaskProposal             本地控制面入口（非模型工具）
   ├─ 取该会话最近用户消息引用 + 会话登记的主个体
   ├─ MainAgentTaskProposalContract.parse/submit          packages/core/src/orchestration/main-agent-proposal-contract.ts
   │  └─ 白名单/禁用字段/引用一致性/层级/目标个体 校验
   └─ ConversationTaskInsertionController.submitProposal  既有控制面（来源/优先级/锚点/revision）
      └─ TaskSequenceManageController.insertTask → AgentTaskSequenceStore（任务偏序权威）
工具面
└─ application-runtime                                    packages/core/src/application/application-runtime.ts
   ├─ 装配期：PONDER_READONLY_TOOL_NAMES ⊆ MainAgentReadonlyToolProjection（否则失败）
   └─ 运行时：ponder 工具名 = 已注册 ∩ 投影
```

## 5. 未完成（明确不算本 ADR 已交付）

- **默认对话 → 主 Agent 高层评估**的生产接线尚未完成：当前 Assist 仍直接
  `decomposePromptForScriptedRun`（固定 T-001）建 mission。这需要 ALIGN-02-02 的规划与
  权威任务序列，本 ADR 只交付"提案一旦产出就安全落库"的边界。
- **所需产物**已按 ALIGN-01-04 落进任务节点（`AgentTaskNode.requiredArtifactIdentifiers`，
  schema 有界 50 项），但**只是声明**：产物是否真实存在仍由产物登记与完成门禁判定。
- **小型任务显式直投**（01-04 后半）**未接线**：`DirectDispatchController` 与
  `executeDirectDispatchCommand` 均存在，但 ①CLI 未注册该子命令、②公开 SDK 未暴露直投、
  ③`insertTask` 要求目标序列已发布而全仓**没有任何生产代码调用 `publishSequence`**。
  ⇒ 直投消费者留待 ALIGN-02-01（权威任务序列生命周期）建立后再接，避免在此另造一套序列创建语义。
- **报告索引来源注入**（01-06）未接。
- 提案接受后的用户可见回执/报告尚未实现（提案成功只返回标识，不宣称任务已执行）。

## 6. 验证状态

**implemented-unverified**：本轮按任务卡口径未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
