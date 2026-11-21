# COORD-02：消息版本与授权标记（生产者前置）

**状态**：`implemented-unverified`（§7 五段均已实现并有反例；反馈进程 fork 链路已打通并经端到端验证。仍缺仓内生产调用方，见 §13「阻塞」）
**立卡日期**：2026-11-17
**来源**：P1-3 返修时发现的硬前置（见 `COORD01_TASK_FEEDBACK_CONSUMPTION_REPAIR.md` P1-3 要求 7）

## 1. 为什么立这张卡

P1-3 要求"只把**已授权、版本适用**、预算内的消息放进模型请求"。本轮已实现：

- ✅ 预算内选择（`selectCoordinationContextEntries`，按渲染长度装填）；
- ✅ 未被选中的消息保持 `pending`，只对**实际携带**的标 `delivered`；
- ❌ **版本适用性**与**授权校验无法实现**。

原因不是没写代码，而是**没有字段可依据**：

```text
FeedbackMessage 字段（core/types.ts:513）
  messageId / source / recipientId / priority / createdAtIso / idempotencyKey
  projectIdentifier? / missionIdentifier? / taskIdentifier? / replyToMessageIdentifier?
  ⇒ 没有 taskRevision（任务版本）
  ⇒ 没有 authorizationEpoch（授权代际）
```

消费端若自行"猜一个版本/授权"，等于**伪造授权**——这是本卡拒绝做的事。

## 2. 需要上游补的字段（本卡的唯一前置）

| 字段 | 语义 | 谁填 |
|---|---|---|
| `taskRevision?: number` | 该反馈所基于的**任务链 revision** | 生产者在构造反馈消息时，从任务链读取并写入 |
| `authorizationEpoch?: number` | 该反馈所属的**授权代际**（撤权后递增） | 生产者在受权状态下写入；无授权上下文则不填 |

字段在存储格式中可选，以便读取旧记录；不能据此跳过授权。需要任务版本比较而缺版本的消息不携带；需要授权而缺章的消息按 §7 阻断。不得默认绑定当前版本。

## 3. 消费端接线（字段就绪后要做的事）

| 步骤 | 内容 |
|---|---|
| ① | `collectPending` 返回条目增加 `taskRevision` / `authorizationEpoch` |
| ② | 保留现行任务版本/尝试门禁；对需授权消息另按 §7 校验授权关系和代际 |
| ③ | 未通过过滤的消息**保持 pending**（与预算排除同一处理，不丢不误确认） |
| ④ | 提示词区块标注**已验证**还是**未验证**（不得把未验证内容说成已验证事实） |
| ⑤ | 反例：旧 revision 消息不携带；撤权（epoch 变化）后旧消息不携带；字段缺失 ⇒ 保守处理 |

## 4. 验收判据

1. 旧 revision 的反馈**不会**进入模型请求（反例可稳定复现）；
2. 撤权后（epoch 递增）旧 epoch 的反馈**不会**进入；
3. 缺必需字段 ⇒ 不进入实际请求，不触发动作，不标已消费；不得以“未验证”标签代替门禁；
4. 上述三条都有测试捕获**实际请求载荷**（不只看状态字段）；
5. 既有 P1-3 行为不回归（预算选择、pending 保持、unknown 态）。

## 5. 明确不做

- 不在消费端推断版本/授权（拒绝伪造）；
- 不改独立审查默认开关；
- 不引入第二套任务版本存储（revision 只认任务链）。

## 6. 现状证据

| 项 | 位置 |
|---|---|
| 预算选择（已实现） | `packages/core/src/orchestration/coordination-context-delivery.ts` |
| Worker 只标记被携带的消息（已实现） | `packages/core/src/orchestration/worker-agent.ts` |
| 反例（预算部分携带） | `tests/core/integration/coord01-context-delivery-wiring.test.ts` ⑦ |
| 缺字段的事实 | `packages/core/src/core/types.ts:513`（`FeedbackMessage`） |

## 7. 待实施裁决：授权代际生命周期

本节是生产与消费两端的共同契约。§1、§6 是立卡时的背景；已有协作载荷字段不等于全链已授权。顺序：先接权威授权写入口，再接生产盖章与传输，最后接实际请求装配及回归。

| 环节 | 必须实现的行为 |
|---|---|
| 权威来源 | 在**实际允许该投递的本地授权关系记录**上持久保存稳定的关系标识和整数代际；跨项目路径从 `cross-project-authorization-store.ts` 追到实际授权写入口。不使用全项目计数、模型输入、消息库或内存计数作权威。关系绑定项目、授权主体、收发个体和准许范围，由本地策略判定，不由消息自行声明是否免验。 |
| 建立与变更 | 新关系首次有效代际为 1。撤销、收窄或替换时，授权变更与递增在同一持久化提交内完成；同一变更重放不重复递增。保留撤销记录或持久高水位，同一关系重新授权必须取得更高代际。进程重启不重置，其他关系不递增。到期、当前权限不足或任一必需上游授权失效，即使数字相同也拒绝。旧记录迁移只初始化当前权威关系，不给历史消息补章。 |
| 生产与传输 | 本地可信入口在确认授权时从同一权威版本取得关系标识与代际，绑定原操作与消息；不得接纳模型自报的章。收件箱、发件箱、反馈映射、持久化和重试原样传递。检查 `collaboration-inbox.ts` 的缺省 0、投递路径可选的当前代际、普通反馈信封及其 schema；历史 0、缺字段、查不到权威关系都不能成为有效章。 |
| 消费与恢复 | 在组装实际模型请求前按当前授权复核；投递本身不授予工具执行权。需授权且缺章、错关系、旧章、过期或查询失败：不入上下文、不触发动作、不确认已消费；保留 pending 和可诊断原因。永久失效项退出自动投递候选，仅供查阅；暂时不可读仅在权威存储恢复后重新校验，不忙轮询。只有本地策略明确无需这类授权的普通消息可不带章，仍走原有身份、路由、任务版本和预算门禁。未知类别不按普通消息放行。 |

**验收以真实装配路径为准**（本地假 Provider 捕获请求即可，无需真实额度）：

1. 旧反馈入队 → 撤权 → 重启 → 同一对象重新授权 → 入队新反馈。相同任务、预算充足：旧反馈从未进入请求或被确认；新反馈进入并按原契约确认。并行的无关项目/授权关系仍能投递。
2. 分别覆盖收窄、到期、关系不符但代际相同、历史缺章/0、冒用章、权威存储暂不可读；核对实际载荷及消费回执。模拟存储恢复，仅仍有当前有效原章者可继续。重复调度不得产生重复投递或诊断风暴。
3. 重放同一撤销请求只递增一次；延迟发送及重试保留旧章；明确无需授权章的普通消息仍能送达。保留旧任务版本、执行尝试和预算排除反例，不能靠屏蔽全部消息让负例通过。
4. 实施者提交生产入口、权威持久化、消息透传和请求载荷的证据后，按工程规则同步本卡与计划状态。本次政策裁决本身不改变交付状态。

## 8. 施工记录：§7 第一部分（权威来源 + 建立与变更，2026-11-18）

### 已实现

| 要求 | 实现 |
|---|---|
| 权威来源 | `CrossProjectAuthorizationRecord.authorizationEpoch`（持久化在**实际授权关系记录**上，不是内存计数/消息字段） |
| 关系标识 | `buildRelationshipKey`：项目 + 授权主体 + 收发个体 + 操作种类 + 范围指纹；关系变化视为新关系 |
| 首次代际 | 关系首次有效 = **1** |
| 撤销递增 | 撤销与代际 +1 在**同一次内存变更 + 同一次原子持久化**内完成 |
| 重放幂等 | 同记录同理由的重复撤销 ⇒ 不再递增 |
| 重启不重置 | 新实例从磁盘读回同一代际 |
| 重新授权 | 同一关系重新授权 ⇒ `highestEpoch + 1`（> 已撤销的代际） |
| 旧记录迁移 | 缺字段在载入时初始化为 1（只初始化权威关系，不给历史消息补章） |

### 反例（`tests/core/integration/authorization-epoch-lifecycle.test.ts`，6 条全过）

① 新关系 = 1；② 撤销后 = 2 且重启仍为 2；③ 重复撤销不再涨；④ 重新授权 = 3；
⑤ 换接收个体视为另一关系 = 1；⑥ 旧记录载入补 1。

### 明确未做（不得据此宣布全链已授权）

- 生产盖章（本地可信入口从权威版本取关系标识 + 代际并写入消息）；
- 传输透传（收件箱/发件箱/反馈映射/持久化/重试）；
- 消费复核（组装实际请求前按当前授权校验，缺章/错关系/旧章/过期一律不入上下文）。

### 门禁

**850 files / 5515 passed + 4 skipped，exit 0**。
## 9. 施工记录：§7 第二部分（消费侧权威复核，2026-11-19）

### 已实现

| §7 要求 | 实现 |
|---|---|
| 在组装请求前按当前授权复核 | `deliverWithAuthoritativeAuthorization`：投递前回权威存储复核 |
| 缺章 / 缺关系标识 | 拒绝：`authorization-missing` |
| 关系查不到 | 拒绝：`authorization-missing` |
| 权威存储不可读 | 拒绝：`authorization-unreadable`（不忙轮询） |
| 已撤销 | 拒绝：`authorization-revoked` |
| 旧代 / 错关系 | 拒绝：`authorization-epoch-stale` |
| 入箱代 0（历史缺章） | 拒绝：`authorization-epoch-absent`（**不因数字相同放行**） |
| 不确认已消费 | 拒绝时只 `recordDeliveryFailure`，消息保持 `received`（pending） |
| 消息携带权威关系标识 | `CollaborationInboxMessage.authorizationIdentifier`（缺省 null ⇒ 缺章） |

### 反例（`authoritative-delivery-consumer.test.ts`，5 条）

① 当前代 ⇒ 投递；② 缺关系标识 ⇒ 拒绝且保持 pending；③ 查不到 ⇒ 拒绝；
④ 撤销 ⇒ 拒绝，重新授权后代际升到 3，带旧代的**新关系**消息仍被拒；
⑤ 入箱代 0 ⇒ 拒绝。
**承重证明**：同时摘掉本模块的代际比较与 `markDelivered` 的代际参数 ⇒ 用例④变红（旧代被放行）。

### 仍未做（不得据此宣布全链已授权）

- ~~**生产盖章**~~：**已实现**——`enqueueWithAuthoritativeStamp` 只从权威存储取章（见 §11）；
- ~~**装配点接线**~~：**已接线**——`CollaborationInboxDeliveryService` 新增 `resolveAuthoritativeAuthorizationEpoch` 端口，投递循环逐条复核（见 §10）。
- ~~发件箱/反馈映射的**关系标识**透传~~：**已实现（2026-11-21，见 §12）**——信封、发件箱、`feedbackMessageSchema` 三处原样携带。

### 门禁

**862 files / 5539 passed + 4 skipped，exit 0**。
## 10. 施工记录：§7 第三部分（投递通道逐条复核，2026-11-19）

| §7 要求 | 实现 |
|---|---|
| 在组装/投递前按当前授权复核 | `CollaborationInboxDeliveryService` 新增端口 `resolveAuthoritativeAuthorizationEpoch`，在**投递循环内逐条**调用 |
| 拒绝时不投递 | 被拒消息 `continue`：**不调用 transport**，只 `recordDeliveryFailure` |
| 不确认已消费 | 状态保持 `received`（pending），落盘后仍可重试/查阅 |
| 可诊断 | 报告新增 `skippedUnauthorizedCount`；交付尝试计数随消息落盘 |
| 旧代 | 复核通过但代际不一致 ⇒ `skippedStaleCount`（同样不投递） |
| 向后兼容 | 未提供端口 ⇒ 保持旧行为（只比较调用方给的 `currentAuthorizationEpoch`） |

### 反例（`authoritative-delivery-assembly.test.ts`）

三条待投递（通过 / 已撤销 / 旧代）⇒ 报告 `delivered=1, skippedUnauthorized=1, skippedStale=1`，
transport 只被调用 **1** 次，落盘后 `m-ok=delivered` 而 `m-revoked`、`m-stale` 仍是 `received`。
**承重证明**：把端口分支短路 ⇒ 三条全部被投递（`deliveredCount` 从 1 变 3），用例变红。

### 仍未做

- 生产侧把权威 `authorizationIdentifier` 写入消息（发送入口），以及发件箱/反馈映射的关系标识透传。

### 门禁

**863 files / 5540 passed + 4 skipped，exit 0**。
## 11. 施工记录：§7 第四部分（生产侧盖章，2026-11-19）

| §7 要求 | 实现 |
|---|---|
| 本地可信入口从同一权威版本取关系标识与代际 | `resolveAuthorizationStamp` / `enqueueWithAuthoritativeStamp` |
| 不得接纳模型自报的章 | 入箱时**忽略**调用方给的 `authorizationEpoch` / `authorizationIdentifier`，一律用权威值 |
| 撤销 / 过期 / 查不到 / 不可读 | 拒绝盖章：`authorization-revoked` / `authorization-expired` / `authorization-missing` / `authorization-unreadable`，**不入箱** |
| 到期即使数字相同也拒绝 | 过期检查先于盖章返回 |

### 反例（`authorization-stamping-producer.test.ts`，4 条）

① 调用方伪造代 99 + 伪关系 ⇒ 入箱仍是权威 `authorization-1` / 代 **1**（**承重**：改成采信调用方值即红）；
② 已撤销 ⇒ 拒绝且不入箱；③ 已过期 ⇒ `authorization-expired`；④ 查不到 ⇒ `authorization-missing`。

### 仍未做

- ~~发件箱 / 反馈映射的**关系标识**透传（代际已透传；需扩展信封 schema）~~：**已实现（2026-11-21，见 §12）**；
- ~~真实跨进程投递链路（反馈进程 fork）里调用 `enqueueWithAuthoritativeStamp`~~：**已打通并经端到端验证（2026-11-21，见 §13）**（当时依赖的 schema 阻塞已同时修掉）。

### 门禁

**864 files / 5544 passed + 4 skipped，exit 0**。

## 12. 施工记录：§7 第五部分（传输层关系标识透传，2026-11-21）

### 要求与实现

| §7 要求 | 实现 |
|---|---|
| 收件箱 / 发件箱 / 反馈映射 / 持久化 / 重试**原样传递** | 收件箱早已带 `authorizationIdentifier`；本次补齐**反馈映射**（`buildCollaborationFeedbackMessage` 写入信封）与**发件箱**（`CollaborationOutboxTransport.send` 落盘） |
| 普通反馈信封及其 schema | `FeedbackMessage.authorizationIdentifier?: string` 新增；`feedbackMessageSchema` **登记**该字段（空串 ⇒ 校验失败）。不登记会被 zod 静默剥离 |
| 历史 0 / 缺字段 / 查不到权威关系不得成为有效章 | 传输层只做"携带"，不做判定：缺省/空串/空白/null ⇒ **不写**（不伪造空章）；有效性仍由消费侧回权威存储复核。未引入任何默认值 |

传输层携带判定收敛到一处：`carriedAuthorizationIdentifier`（`collaboration-authorization-stamping.ts`），
只把**非空字符串**视为带章。

### 反例（先红后绿）

| 文件 | 用例 | 实现前 |
|---|---|---|
| `tests/core/unit/collaboration-feedback-mapping.test.ts` | ⑤ 信封带同一关系标识且载荷代际不变；⑥ 缺省/null/空串/空白 ⇒ 信封不出现该字段 | ⑤ 红（undefined） |
| `tests/core/unit/collaboration-outbox-transport-fields.test.ts` | ⑤ 落盘文件带关系标识（与代际配对）；⑥ 空串不落盘 | ⑤ 红（undefined） |
| `tests/core/unit/collaboration-authorization-stamp-passthrough.test.ts` | ① JSON 往返 + schema 校验后仍带标识；② 缺省不注入；③ 空串校验失败；④ payload 内伪造字段不算章 | ① 红（被 schema 剥离） |

实现前实测：**5 条红 / 11 条既有绿**（16 条中）；实现后 **16/16 通过**。

### 承重证明

摘掉 `feedbackMessageSchema` 里登记的 `authorizationIdentifier` ⇒ 透传用例 ①、③ 立即变红
（① 字段被 zod 剥离；③ 因字段消失而"通过"）。摘掉映射/发件箱的写出语句 ⇒ 对应 ⑤ 变红，
已在实现前实测（实现前就是红）。

### 顺带发现（第 1 条已在 §13 补齐，第 2 条已修）

1. ~~`feedbackMessageSchema` 未登记~~ `missionIdentifier` / `replyToMessageIdentifier` /
   `taskRevision` / `executionAttempt` / `projectIdentifier` / `taskIdentifier`
   ⇒ **已登记（2026-11-21，见 §13）**；摘掉登记时反例⑥会红。
2. ~~协作请求载荷**过不了** `feedbackMessageSchema`：`PRIORITY_OF_KIND` 缺 `collaboration-request`；
   映射生成的 `messageId` 是 `collaboration:<id>`、不满足 `z.uuid()`~~：**已修（2026-11-21，见 §13）**。
   同时发现并修掉"子进程拒绝被客户端当成功"的静默丢弃（这也是本条此前一直被遮蔽的原因）。

### 仍未做

- ~~真实跨进程投递链路（反馈进程 fork）里调用 `enqueueWithAuthoritativeStamp`~~：**已打通并经端到端验证（2026-11-21，见 §13）**；仍缺**仓内生产调用方**（属产品决策，见 §13「阻塞」）。
- ~~上面「顺带发现」两条~~：协作消息过 schema 已修（§13）；其它信封字段登记**仍未做**（§12 §1）。

### 门禁

**866 files（860 passed / 4 failed / 2 skipped），5556 tests（5545 passed / 4 failed / 7 skipped），exit 1**（2026-11-21 本机实跑）。

4 条失败全部**与本次改动无关**，逐条定性：

| 失败 | 定性 | 证据 |
|---|---|---|
| `project-scope-boundary` ③ 链接逃逸 | 本机环境（Windows 创建符号链接/联接需特权） | 同一用例在**基线 HEAD（stash 掉本次改动）上同样红** |
| `tool-registry` 符号链接逃逸（清理 ENOTEMPTY） | 同上 | 同上 |
| `exec01-02-cli-bootstrap-autodetect` | 本机没有可用的隔离执行后端（测试断言"未装配"文案） | 同上 |
| `goal-requirement-mapping-concurrency` ①（40 条并发） | **负载抖动** | 隔离复跑 **1/1 通过** |

另有 2 条架构用例（`cli-numeric-option-guards`、`mutation-anchors-live`）在**首次**全量里红，
原因是本机 `core.autocrlf=true` 检出成 CRLF、而这两条按 LF 文本匹配；把工作树规范为 LF
（`git config core.autocrlf false`）后 **6/6 通过**，源码未改任何锚点。

定向反例（本次 3 个文件 16 条）：**16/16 通过**；`typecheck` exit 0；`lint` exit 0。

## 13. 施工记录：§7 第六部分（反馈进程链路打通，2026-11-21）

### 先证实"绿的断"

跑 `comm02-inbox-feedback-process` 时，子进程 stderr 明写拒绝：

```text
astarray: 反馈进程拒绝非法消息（schema 校验失败）: Invalid UUID / priority instruction 与 payload kind collaboration-request 不一致
```

而用例仍然**通过**（`deliveredCount=1`）。三条独立缺陷叠在一起：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `PRIORITY_OF_KIND` 缺 `collaboration-request` ⇒ `expectedPriority=undefined` | 任何优先级的协作消息都被判"不一致" |
| 2 | 映射产出 `messageId = "collaboration:<id>"`，schema 要求 UUID | 合法协作消息永远过不了校验 |
| 3 | 客户端不看 `enqueued.accepted`，拒绝后照样删补送文件 | **静默丢消息**；`delivered` 是假的 |

### 修复

| 层 | 改动 |
|---|---|
| schema | `PRIORITY_OF_KIND` 增 `collaboration-request: "instruction"`（与 `worker-agent.payloadPriority` 对齐） |
| 映射 | `messageId` 从协作标识**确定性派生 UUID**（v5 形状）：同标识稳定、异标识不同；原标识仍在 `payload.messageIdentifier`（回复路由用它） |
| 客户端 | 抽出 `requestEnqueue`，`accepted === false` ⇒ 抛新错误码 `feedback-message-rejected`；补送文件保留（不删、不伪装成功） |
| SDK | 导出 `enqueueWithAuthoritativeStamp` / `resolveAuthorizationStamp` / `carriedAuthorizationIdentifier`，宿主可装配"盖章 → 入箱" |

### 反例（先红后绿）

| 用例 | 实现前 |
|---|---|
| `collaboration-feedback-mapping.test.ts` ⑦ messageId 为确定性 UUID | 红 |
| `feedback-client.test.ts` accepted:false ⇒ 抛错且补送文件保留 | 红（此前静默 resolve） |
| `collaboration-authorization-stamp-passthrough.test.ts` ⑤ 映射整封过 schema | 红 |
| `feedback-process.test.ts` 两条"拒绝"用例改为断言**拒绝上抛** | 此前靠静默通过，改后才是真断言 |

### 端到端证据（真实 fork 进程）

`coord02-stamped-fork-link.test.ts`：SDK 盖章入口入箱 → 落盘 → 交付服务 → 反馈映射 →
`CollaborationFeedbackTransport` → **真实反馈子进程** → 投递回接收侧，断言：

- `messageId` 是 UUID、`priority=instruction`；
- `authorizationIdentifier=authorization-1`、`payload.authorizationEpoch=1`（章原样到达）。

相关套件复跑 **11 files / 123 tests 全过**；`typecheck` exit 0；`lint` exit 0。

### 阻塞（需要产品决策，不是技术缺口）

- **仓内没有协作消息的生产调用方**：`CollaborationInbox` 只被测试与 SDK 暴露，`inbox deliver` CLI
  只做"投递已有的箱内消息"。决定"协作请求从哪个入口发起（工具 / CLI / 宿主装配）"属于产品形态，
  不能凭空新增入口。**SDK 盖章入口 + 可用的 fork 链路已就绪，宿主接线即可。**
- ~~永久性拒绝（schema/身份不合法）的消息会留在补送 outbox 里按 ≤60s 退避**无限重试**~~：
  **已裁决并实现（2026-11-21，用户裁决 C）**——子进程回传 `rejectionCode`，永久类转死信并移出补送、
  暂时类保留退避；见 [ADR-0060 §6](../adr/0060-feedback-idempotent-journal-and-outbox.md)。
- 协作请求的**读取出口**已按用户裁决 A 接到 `taskSequenceStatus`（同一次读取同时返回
  `pendingCollaboration`，只读、身份隔离、授权过滤、分页），见 [COORD-04](COORD04_COLLABORATION_INBOX_READ_OUTLET.md)。
- ~~`feedbackMessageSchema` 仍未登记 `missionIdentifier` / `replyToMessageIdentifier` / `taskRevision` /
  `executionAttempt` 等既有信封字段~~：**同轮已补**（另加 `projectIdentifier` / `taskIdentifier`）。
  反例⑥（往返后字段仍在）在摘掉登记时变红。

### 门禁（本机全量）

**867 files（862 passed / 3 failed / 2 skipped），5561 tests（5551 passed / 3 failed / 7 skipped），exit 1**。
3 条失败与本轮改动无关，且都已在基线 HEAD 上复现：`project-scope-boundary` ③、`tool-registry` 符号链接
（Windows 创建链接需特权）、`exec01-02-cli-bootstrap-autodetect`（无隔离执行后端）。