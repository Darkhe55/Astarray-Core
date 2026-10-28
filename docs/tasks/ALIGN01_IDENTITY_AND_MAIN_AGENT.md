# ALIGN-01：稳定个体身份与只读主 Agent 主干

日期：2026-10-27。状态：in_progress（01 已交付，implemented-unverified；2026-10-28）。

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
