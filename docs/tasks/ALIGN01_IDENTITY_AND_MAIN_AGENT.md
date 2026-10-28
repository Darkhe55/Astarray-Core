# ALIGN-01：稳定个体身份与只读主 Agent 主干

日期：2026-10-27。状态：in_progress（01–03、05 已交付、04 部分交付，均 implemented-unverified；2026-10-28）。

执行约定：只修改本卡负责范围；先备份覆盖前文件，保留并行工作。每轮一个编号步骤，超过 3 小时拆分剩余步骤继续。允许更新本卡与所属仓库索引，不授权安装依赖、提交推送或调用真实付费模型。本轮沿用用户要求，不编写/运行测试，不构建或人工验收；按源码调用链交付证据，完成只能标 implemented-unverified，不得宣称运行验证通过。既有测试和 CI 不删除、不弱化。发现相关实现已存在则复用，不重复造轮子；缺少可信授权或遇并行覆盖冲突只阻塞对应步骤。具体模型是否曾替换设计无可靠证据，不作来源归罪。

前置：ALIGN-00。负责 main-controller、个体记忆/会话目录、公共 SDK 身份透传；不改调度优先级。
## 固定实现
1. 复用稳定 projectIdentifier、conversationIdentifier、agentInstanceId；runIdentifier 与 missionIdentifier 单独使用。不存在稳定会话实体时新增最小持久映射，不以宿主进程 ID 或任务 ID 代替会话。每个角色可有多个个体，记忆键必须精确到个体。
2. 修正 ponder 每次生成新个体的路径：一次会话选择既有主个体，新调用仅新建 run；新会话是否复用个体由明确持久关联决定，不按角色名称猜测。恢复时保留个体，关闭后新建必须获得新 ID。
3. 默认用户对话进入主 Agent 交流与高层评估；主 Agent 在全部权限模式下只暴露读取工具。通过既有本地提案控制面提交任务，模型不能直接 spawn、执行、写盘或填写认证授权字段。
4. 提案包含目标次级个体、用户原始任务引用、前驱/后继、expectedRevision、来源和所需产物。由本地服务校验后写入任务序列。小型明确直投是带用户来源的显式路由，不经主模型再次拆解。
5. 任务交付提案后立即释放主 Agent 的任务等待，不等待下级执行完成；单条主 Agent 处理预算上限 180 秒，耗尽保存已知进度并明确返回待补信息/待继续，不能伪造已分发。不能用无限模型重试占住通信。
6. 下级报告进入主 Agent 的只读报告索引并带来源；到用户后续相关交流再读取，不自动把全部报告塞入主上下文。必要提醒由本地通知层发送，不改记忆归属。
7. 旧身份映射只能根据可核对关联迁移；不能按同名角色拼接历史。无唯一关联保持独立并标未知。
## 交付与关闭条件
新增私有信息之外的通用身份/提案契约文档；列出默认交流与显式直投两条生产路径。身份持久化和读入消费者均接上才完成。安全规则继承原权限引擎，不将主 Agent 只读误实现为“主 Agent 无法提出任务”。


## 检查点记录

### 01 稳定身份分层（会话／个体／运行）——implemented-unverified（2026-10-28）

**问题**（ALIGN-00 静态基线，本轮复核仍成立）：`handleUserMessage` 每条消息新建 mission；
ponder 每次生成 `main:ponder:<随机>`；`missionId`/进程内 Map 同时充当"会话"。
⇒ 重启后无法回答"新消息属于哪个会话/哪个主个体"，个体记忆与读取抑制账本没有稳定归属。

**交付**（同一检查点，不新建第二套调度）：

| 层 | 位置 | 作用 |
|---|---|---|
| 契约 | `docs/adr/0044-conversation-individual-and-run-identity.md` | 五层标识分工 + 四条不变量 |
| 存储 | `packages/core/src/orchestration/conversation-identity-store.ts` | `<state>/conversation-identity/conversations.json`（原子写、`.bak` 恢复、revision 单调、互斥） |
| 装配 | `packages/core/src/application/application-runtime.ts` | 默认启用；`isConversationIdentityEnabled === false` 关闭；透传 `mainAgentInstanceId` |
| 入口 | `packages/core/src/orchestration/main-controller.ts` | `handleUserMessage({ conversationIdentifier? })` → 解析会话 → 落 mission → `beginRun` |
| 消费者 | 同文件 `getMissionConversationIdentifier`；`mission-manager.ts` 的 `summary.conversationIdentifier` | 只读查询 + 历史视图可读的会话投影 |
| 错误码 | `packages/core/src/core/errors.ts` | `conversation-identity-{not-found,closed,conflict}` |

**四条不变量（代码强制）**：
1. 会话/主个体标识命中 `mission-*`、`pid:*`、`process-*`、`host:*` ⇒ 冲突（不拿进程/任务冒充会话）；
2. 已登记会话**沿用其主个体**，不因换进程改绑（改绑只走显式 `openConversation`，参数不符即冲突）；
3. 已关闭会话拒绝继续登记运行；继续必须开新会话（新个体）；
4. 无 `projectIdentifier` 的消息不写映射（宁可不记，也不挂到默认项目上）。

**调用链**：`handleUserMessage` → `resolveConversationIdentityForMission` →
`ConversationIdentityStore.resolveOrOpenConversationForProject` → `MissionManager.createMission`
→ `beginRun`（按 mission 幂等）→ 内存 `missionConversationIdentifiers` + 摘要字段。

**验证状态（如实）**：**未编写/未运行测试、未人工验收**（沿用用户口径）。
已通过：`npm run typecheck` exit 0、`npm run lint` exit 0（顺带修掉 5 处基线 lint 红灯）、
`npm run build` 成功（沙箱内 esbuild `spawn EPERM`，经一次性放行后成功）。
⇒ 只能标 **implemented-unverified**，不得宣称"身份恢复已可用"。

**仍未完成**：02 ponder 个体复用；03 主 Agent 只读主干的提案控制面；04 提案字段与
"小型任务显式直投"；05 180 秒预算与释放等待；06 报告索引来源注入；07 旧身份迁移规则。
（03–07 的生产接线均未开始，本卡不得标 done。）

### 02 ponder 复用既有主个体——implemented-unverified（2026-10-28）

**旧行为（实测基线）**：`respondInPonderMode` 每次 `main:ponder:<8hex>` ⇒ 同一会话连续追问
换三个"个体"，个体记忆/读取抑制账本/汇报来源无法归属。

**改法**（`packages/core/src/orchestration/main-controller.ts`）：
1. `handleUserMessage` **先解析项目归属**再分模式（此前 ponder 完全拿不到项目）；
2. ponder 走与 mission 相同的 `resolveConversationIdentityForMission`：命中会话 ⇒ 用
   **登记过的主个体**；无映射但装配层有稳定 `mainAgentInstanceId` ⇒ 用它；两者都无才退回临时 id；
3. 每次调用登记一条**无 mission 的 run**（run 与 mission 正交），因此"持续追问"是
   同一会话/同一主个体/多条 run；
4. `resolveConversationIdentityForMission` 返回值扩展为
   `{ conversationIdentifier, mainAgentInstanceIdentifier }`，mission 分支行为不变。

**有意不做的**：不按角色名/模型名匹配历史个体（卡内禁止猜测）；不给已关闭会话"续命"。

**验证状态**：未编写/未运行测试、未人工验收；`npm run typecheck` exit 0、
`npx eslint main-controller.ts` exit 0。⇒ **implemented-unverified**。

### 03 只读工具面 + 本地提案边界——implemented-unverified（2026-10-28）

**审查发现（实测）**：`MainAgentReadonlyToolProjection` 虽已存在并被 `getMainAgentToolProjection`
使用，但 ponder 的工具面只看 `PONDER_READONLY_TOOL_NAMES`，**不看投影** ⇒ 两处白名单可漂移；
`ConversationTaskInsertionController` 已校验来源/优先级/锚点，但**没有面向主 Agent 的入口**，
无法阻止模型在字段里自填来源或授权。

**交付**：

| 层 | 位置 | 作用 |
|---|---|---|
| 契约 | `docs/adr/0045-main-agent-task-proposal-boundary.md` | 提案字段白名单 + 六条拒绝规则 + 只读单一权威 |
| 解析/提交 | `packages/core/src/orchestration/main-agent-proposal-contract.ts` | 严格白名单、禁用身份/授权字段、用户任务引用一致性、层级 ≥1、目标≠自身；委派既有控制面 |
| 入口 | `main-controller.ts` 的 `submitMainAgentTaskProposal`（**本地控制面，非模型工具**） | 取会话主个体 + 最近用户消息引用，构造 harness 上下文 |
| 引用持久化 | `conversation-identity-store.ts` 的 `ConversationRunRecord.userMessageReference` | 提案必须对应一次真实用户消息 |
| 只读权威 | `application-runtime.ts` | 装配期校验 `PONDER_READONLY_TOOL_NAMES ⊆ 投影`（违反即启动失败）；运行时工具名 = 已注册 ∩ 投影 |

**六条拒绝规则**：未知字段拒绝；身份/授权字段拒绝（`task-sequence-permission-denied`）；
引用不一致拒绝；来源个体无法确定拒绝（不以匿名来源提交）；目标=自身拒绝；层级 0 拒绝。

**未做（如实）**：默认对话 → 主 Agent 高层评估仍缺（依赖 ALIGN-02-02 的规划与权威序列）；
`requiredArtifactIdentifiers` 属 01-04，当前提交会被"不支持的字段"拒绝；小型任务直投、
报告索引来源未接。

**验证状态**：未编写/未运行测试、未人工验收；`npm run typecheck` exit 0、
`npx eslint <本批文件>` exit 0、`npm run build` 成功。⇒ **implemented-unverified**。

### 04 提案字段：所需产物 + 直投路径审计——**部分交付**（2026-10-28）

**已交付：所需产物进入任务序列**
- `AgentTaskNode.requiredArtifactIdentifiers?: string[]`（`core/types.ts`，schema 有界 50 项）；
- `InsertTaskInput` / `TaskInsertionProposal` / `MainAgentTaskProposalContract` 三层透传；
- 校验：非字符串数组、>50 项、重复项一律拒绝；**语义明确为"声明要产出什么"，不证明已产出**
  （完成判定仍走产物登记/完成门禁，不得用本字段谎报 done）。

**审计结论（直投路径，未接线，附证据）**：
1. `DirectDispatchController.dispatchDirectTask` 已实现"用户显式路由 + 保持 user 来源/层级 0 +
   不调用主 Agent 模型"，`t08cRoutingFacade` 也已装配；
2. 但 `executeDirectDispatchCommand`（`packages/tui/src/cli/commands.ts:2176`）**未在 `cli.tsx` 注册**
   —— 全文件检索 `direct-dispatch` 命中 0；
3. 公开 SDK 检索 `directDispatch|dispatchDirectTask` 命中 0 ⇒ 没有任何产品入口能调用它；
4. 且 `insertTask` 要求目标序列已发布，而全仓**只有 `publishSequence` 定义、没有任何生产调用方**
   ⇒ 即使接上命令行，直投也会以 `task-sequence-not-found` 失败。

⇒ 直投的消费者**刻意留到 ALIGN-02-01**（权威任务序列与持续调度）一起接，避免在这里
另造一套序列创建/生命周期语义。本检查点**不标 04 完成**。

**验证状态**：未编写/未运行测试、未人工验收；`npm run typecheck` exit 0、
`npx eslint <本批文件>` exit 0、`npm run build` 成功。

### 05 主 Agent 单条处理预算（180 秒）——implemented-unverified（2026-10-28）

**审查发现（实测）**：`SMART-01-04` 的 `MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS = 180_000`
与 `evaluateInstructionDeadline` **早就存在但没有任何执行方**：ponder 的 `AbortController`
从未被 abort，慢模型/长工具循环会一直占住会话；也没有任何"超期记账"。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 契约 | `docs/adr/0046-main-agent-turn-budget.md` | 硬上限、超期语义、记账字段、落库失败不阻塞 |
| 记账 | `packages/core/src/orchestration/main-agent-turn-budget.ts` | `MainAgentTurnProgressRecord` + 常量 180s；`isTaskDispatched` 恒 false |
| 执行 | `main-controller.ts` `respondInPonderMode` | `AbortSignal.timeout(180s)` + `AbortSignal.any(取消)`；超期当场输出 `[需要继续]` |
| 只读查询 | `getLastMainAgentTurnProgress()` | 供 UI 呈现"超时/待继续" |
| 落库 | `application-runtime.ts` | `<state>/main-agent-turns/<turnId>.json`（原子写；失败不阻塞对话） |

**assist 侧**：创建 mission 后**立即返回**、不 await 下级执行 —— 既有行为即满足
"交付后释放等待"，本轮只核实未改动。

**未做（如实）**：UI 呈现、超时后自动续跑（只有文案承诺）、assist 分支的主 Agent 模型轮次
（等 ALIGN-02-02）、记账保留策略；Provider 侧重试上限未逐一审计。
**超期路径没有用真实慢模型触发过 ⇒ 不宣称"超时一定生效"。**

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。
