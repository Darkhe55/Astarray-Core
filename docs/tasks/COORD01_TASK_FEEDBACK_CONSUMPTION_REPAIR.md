# COORD-01：任务与反馈统一消费协调及恢复闭环返修

日期：2026-11-11。状态：**01 已交付；02–04 implemented-unverified（2026-11-11）**（无人工验收，不标 done）。性质：现有编排接线返修，非新增 Agent 框架，非实验性能力。

## 1. 依据与固定范围

复用 [ALIGN-02](ALIGN02_SEQUENCE_AND_DISPATCH.md)、[ALIGN-03](ALIGN03_EXECUTION_REVIEW_FEEDBACK.md)、[COMM-01](COMM01_ADDRESSABLE_UPPER_LAYER_AND_SINGLE_PARENT_TASK_CARD.md)、[SMART 窗口接线](SMART01_INSTRUCTION_WINDOW_AND_DEADLINE.md) 和 [GUIDE/EVENT](SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md)。本卡补齐它们之间的消费契约，不替代各卡全部工作。

“统一任务消息序列”固定解释为统一身份、路由、幂等消费和状态仲裁规则；任务偏序集与反馈日志仍独立保存。禁止把每条反馈转换成执行任务、另建权威待办、设置全局串行大队列，或让模型担任可靠性协调器。

已有代码复用点：`feedback-process/mailbox-journal.ts`、`delivery-worker.ts`；`orchestration/collaboration-inbox.ts`、`collaboration-inbox-store.ts`、`collaboration-inbox-delivery.ts`、`task-sequence-controllers.ts`、`secondary-continuous-dispatch-loop.ts`、`instruction-window-store.ts`；以及现有本地执行门禁、任务回执、独立审查和上下文注入入口。实施前核对真实调用链；已有行为只补证据，不重复实现。

本卡不新增界面、不修改跨项目只读限制、不允许主 Agent 写工具、不新增安装需求，不将独立审查的产物存在性检查升级为最终验收。

## 2. 消息分类与出口

| 类别 | 包含 | 固定消费语义 |
|---|---|---|
| control | 可信来源的取消、暂停、撤权、紧急停止 | 独立控制通道先更新本地执行门禁；不等待 idle、任务窗口或模型阅读；在途取消依工具能力确认，unknown 不当作已停止 |
| state | 完成/失败/阻塞、审查裁决、授权结果、资源释放 | 本地校验后更新权威状态并请求调度重评估；不自动把文本送给模型 |
| information | 普通进度、摘要、参考材料 | 先归档；不改变任务终态、不释放槽位、不自动唤醒主 Agent；相关任务或用户查询时再读取 |

分类由本地可信事件类型及来源权限决定，不接受模型把消息自标为 control 取得优先权。授权结果必须验证专用授权凭证，消息本身不能授予权限。消息内容无论类别都不能越过本地安全不变量。

次级正常接收并处理下级状态反馈；主 Agent 普通汇报只存档。需模型决定的返修规划或澄清作为有来源的待处理项，通过原任务序列提交，不能伪装成用户最高优先任务。

## 3. 身份、版本与三个消费状态

复用现有 ID 体系。规范信封包含 messageIdentifier、sourceAgentInstanceIdentifier（或可信用户/系统来源）、recipientAgentInstanceIdentifier、projectIdentifier、taskIdentifier、correlationIdentifier、payloadVersion、内容指纹。状态消息另带 taskRevision、executionAttemptIdentifier；适用时带 authorizationEpoch、产物标识与 revision。

- 消息 ID 在首次提交时生成并持久化，传输重试、进程恢复沿用同一 ID。上游缺稳定请求 ID时，首次创建提交记录后返回恢复令牌；不得按文本猜测“两条相同用户输入就是重试”。
- 同身份同 ID 同内容复用原回执；同 ID 异内容拒绝并记录冲突。结构键序规范化，但正文、路径、数值不得随意等价化。
- 版本/执行尝试不符：记录 stale，不改当前状态、不释放槽位。未来版本暂存为 awaiting-reconciliation，不猜测应用；触发一次有界对账，仍不匹配则阻塞该消息并报告。
- 产物引用未提供明确标 not-provided；普通消息可合法无产物。需要产物证明的审查/完成门禁不能凭缺失引用通过；有引用须核对实际版本。
- 老数据缺必要版本或执行身份时，保留只读归档；仅能经已有恢复对账机制确认后更新状态，不能默认绑定“当前一次执行”。

分别持久化：

1. deliveryState：是否可靠入库及投递确认；可靠收到不等于应用成功。
2. applicationState：pending / applied / ignored-stale / blocked / rejected；附原因、目标状态版本、处理尝试次数。
3. contextDeliveryState：not-required / pending / delivered / unknown；delivered 只代表模型请求已携带，不能称为模型已理解；网络结果不明记 unknown，不通过重发业务动作补偿。

只读查询返回三种状态、来源、版本和原因。禁止用一个 consumed 布尔值同时代表上述状态。

## 4. 协调、事务与恢复

1. 分区键为项目 ID + 责任调度 Agent 个体 ID。唯一直属上级规则不变；同层可通信不代表获得改任务的权限。跨项目消息须现有授权，且不得直接修改另一项目任务或文件。
2. 反馈进程负责可靠入库和投递；本地协调器在接收入库后执行短状态事务。不能让“接收者模型忙”阻止 state/control 的本地处理；information 仍按原归档策略处理。
3. 每个分区短事务串行化，模型调用、工具运行、网络和等待授权均在事务外。不得用内存 mutex 代替跨进程所有权；复用持久租约、版本 CAS 与 fencing，旧消费者失去租约后不得提交。
4. 采用可重放消费记录：先持久化处理意图，再以 messageIdentifier 为幂等键调用权威状态控制器，最后记录已应用与待唤醒标志。状态更新须能原子保留该幂等键；恢复时可判断是否已应用，不靠进程内 Set。
5. 唤醒是可重复的“重新计算 ready set”信号，不是“直接再启动一次任务”。任务领取/派发继续走既有租约及幂等接口。崩溃后扫描未收口处理记录和待唤醒标志补偿，不重放已确认工具副作用。
6. 更新任务时保留独立审查和人工作用：执行者自报 success 只提交执行结果，不代表最终验收或合并批准。依赖是否解除按既有权威完成门禁，不能由本卡弱化。
7. 临时消费失败使用 1/2/4/8/16 秒有界退避，单轮自动尝试最多 5 次；持久化计数，重启不清零。超限 blocked 并给可查询原因，不阻塞其他任务。人工或有权控制器显式重试才能开始新轮。取消/撤权门禁失败时阻断受影响分区的新执行并报告，不误报已停止。
8. 源日志不可读、记录损坏或磁盘满明确报告；保留旧有效状态，不静默清空日志。所有覆盖/删除遵循工具层自动备份，备份删除走既有独立授权入口。

## 5. 公平性、窗口与上下文

- control 不受普通任务窗口限制，不通过无限高优先模型任务实现紧急处理；重复控制按事件身份幂等，独立风险不得合并丢弃。
- 每轮普通协调最多处理 32 条 state 或占用 10 ms（先到为准），随后让出事件循环并评估一次派发；安全门禁仍优先，公平性不允许恢复未解除的危险任务。注入可控时钟测试，单条本地处理不可含长等待。
- ready set 保留偏序依赖和用户最高任务层，同层稳定排序。信息风暴只合并显示通知，不删除原记录、不挤占 state 处理配额。
- 满窗继续可靠接收任务与反馈，禁止越窗准入；已准入任务的必要下级执行和结果回收不停止。
- 主 Agent 的意图槽位在“任务已持久化交办且获得可信交办回执”后释放，不等待下级最终产物。交办回执与执行完成回执分开；重复/迟到回执只释放一次，交办失败不伪造释放。
- 控制器只把确需模型处理的内容放入既有安全点/上下文准入接口，不直接复制全部反馈日志。普通报告查询不隐式启动续跑。幂等应用状态与上下文注入回执分开维护。

## 6. 顺序与交付责任

| 检查点 | 必须交付 | 状态 |
|---|---|---|
| COORD-01-01 | 原接口→生产调用方→持久状态→消费方对账表；冻结信封/三状态；核实 EVENT 卡冲突状态，以源码证据纠正 | **对账表已交付（2026-11-11）**：[COORD01_01_ALIGNMENT_TABLE_2026-11-11.md](../reports/COORD01_01_ALIGNMENT_TABLE_2026-11-11.md)。EVENT 独立卡不存在（4 处引用已列出）待确认 |
| COORD-01-02 | 反馈可靠接收→状态幂等更新→调度重评估；分区、租约、短事务、失败恢复及查询入口 | **implemented-unverified（2026-11-11）**：分区租约+fencing、短事务（幂等/CAS/待唤醒）、消费步、持久退避、三状态查询、唤醒→重算 ready set 均已接线并有反例；待人测 |
| COORD-01-03 | 稳定重试身份、执行/产物版本、交办回执释放窗口、控制旁路与上下文准入接线 | **implemented-unverified（2026-11-11）**：身份贯通公开入口（重投去重、同文本不误合并）、产物版本四态核对+消费门禁、交办回执释放（失败不释放）、控制旁路（agent 拒绝、unknown 不报已停止、派发门禁）、上下文准入（仅决策类注入、注入≠续跑）；待人测 |
| COORD-01-04 | 故障注入、并发/权限回归、真实应用入口和 tarball 隔离验证，更新相关卡状态与证据索引 | **implemented-unverified（2026-11-11）**：三处崩溃窗口（状态已写未回写/租约过期接管/重启重放）、两进程竞争与旧 token 迟提交被拒、控制与产物门禁回归、`scripts/verify-coord01-package.mjs` 隔离安装 `ok failures=0`；待人测 |

顺序 01 → 02 → 03 → 04；每轮一个检查点，超过三小时在可恢复边界拆分。不同职责可复用已有模块，不把本卡全部实现堆到 main-controller。

必须更新本卡与相关计划状态；已有范围内接线不再列为“新增产品功能待批准”。仅记录实际完成范围。共享文件被并行修改时，新建 `docs/reports/STATUS_UPDATE_COORD01_<日期>.md`，说明待合入位置，不覆盖别人的工作。与 ALIGN-03 独立审查施工重叠时只接稳定接口，缺接口作为明确依赖，不制造替代验收。

## 7. 固定验收反例

- 同消息重复投递、重复状态应用、同 ID 异内容、上游重试、同文本不同用户指令；结果分别幂等/拒绝/不误去重。
- 收到后未应用崩溃、状态已更新未记回执崩溃、记回执未唤醒崩溃；恢复均不丢状态、不重复派发。
- 两进程同分区竞争、租约过期接管、旧消费者迟提交；只有当前所有者能提交。
- 旧 executionAttempt/任务 revision/产物 revision 不能更新新运行；缺身份、未来版本和无产物状态均有明确回执。
- 满窗仍接收完成/阻塞反馈；持久交办释放一次槽位；下级仍运行不影响此释放；交办失败不释放为成功。
- 长工具/模型忙期间撤权立即阻止后续未启动操作；取消请求不冒充停止确认；不支持取消时如实报告并禁止后续动作。
- 普通进度洪水下 state 能处理，安全允许时任务获得派发机会；关键控制不等待模型/idle；没有持锁等待和循环依赖。
- 主 Agent 普通报告只归档；读取查询不执行任务；无权限/跨项目/假冒来源拒绝；读取权不升级为任务修改权。
- worker 自报成功、审查 rejected、人工未批准等情况不误合并；本卡不得以状态协调之名绕过 ALIGN-03。
- 生产入口测试必须经过反馈入库、消费协调、任务存储、真实派发接口，不以直接调用内部处理函数代替；模型可用确定性本地替身。

运行相关测试、`npm run check` 与安全专项；用可控时钟及故障注入消除真实睡眠计时脆弱。按仓库现有脚本执行 npm pack、包校验和隔离安装冒烟，再从安装后的公共应用入口验证重复消息、恢复与查询。无需真实付费模型和额外依赖。

记录接收→应用、应用→调度唤醒的延迟、队列积压、重复数、stale 数、blocked 数及恢复结果；报告设备和负载，不将样例延迟宣称硬实时保证。四检查点均有生产接线与验证证据才可整卡 done；EVENT 或独立审查依赖未闭合时只关闭不受影响的检查点。

### COORD-01-02 进展（2026-11-11）：**应用状态**与投递状态已分离并可幂等记录

**依据**：卡 §3"可靠收到不等于应用成功"、"禁止用一个 consumed 布尔值同时代表三种状态"。

**交付**：`feedback-process/mailbox-journal.ts`

| 变更 | 说明 |
|---|---|
| `JournaledMessage.applicationState` | `{ state, reason, targetStateVersion, attemptCount, updatedAtIso }`；五态：`pending / applied / ignored-stale / blocked / rejected` |
| `JournaledMessage.contextDeliveryState` | 四态：`not-required / pending / delivered / unknown` |
| `recordApplicationState(...)` | 以 `messageId` 为幂等键：同版本同结论 ⇒ `idempotent-replay`（不重复计数）；目标版本更低 ⇒ `ignored-stale`（**不覆盖**已应用结论）；未入库 ⇒ `not-found` |

**用例 4 条**（`tests/core/unit/coord01-application-state.test.ts`）：①首次上报 applied 且 `delivered` 仍为 false（投递/应用分离）；
②同版本重放不重复计数；③低版本被标 stale 且已应用结论不被覆盖；④未入库消息 not-found。

**仍未做（属 02 后续切片）**：① 持久状态更新与调度重评估的接线（当前只落 journal，未触发重评估）；
② 分区（项目 ID + 调度 Agent）与租约/fencing；③ 信封补 `projectIdentifier` / `taskIdentifier`；
④ `contextDeliveryState` 的写入点（上下文准入接线）。

### COORD-01-02 进展（2026-11-11 巡检轮）：规范信封的**归属键**已落地

按 §3 规范信封补齐两个缺失字段：

| 字段 | 变更 |
|---|---|
| `projectIdentifier` | `FeedbackMessage` 新增可选字段（分区键之一） |
| `taskIdentifier` | 同上；`buildCollaborationFeedbackMessage` 把任务归属写入**信封**（不再只放在 payload） |
| 幂等比较 | 归属键不同 ⇒ 视为"同键异内容" ⇒ `operation-not-idempotent`（不静默复用） |

**用例 3 条**：①归属键持久化；②同幂等键但 `taskIdentifier` 不同 ⇒ 拒绝；③旧消息缺归属键仍可入池（向后兼容）。

**仍未做**：调度 Agent 个体 ID 分区、租约/fencing、状态更新→调度重评估接线、`contextDeliveryState` 写入点。

### COORD-01-02 进展（2026-11-11 目标轮 1）：分区租约 + fencing

按卡 §4.1/§4.3 落第一块：**协调分区**与**租约 ownership 校验**。

| 交付 | 说明 |
|---|---|
| `buildCoordinationPartitionKey` | 分区键 = `project:<项目ID>|scheduler:<调度Agent个体ID>`；任一为空即拒绝（不用默认值猜） |
| `CoordinationPartitionLeaseStore` | `tryAcquire / renewLease / releaseLease / assertIsCurrentOwner`，每分区一个 JSON（原子写 + 备份恢复读取） |
| fencing token | 每次授权/接管/释放都**递增**，旧 token 永久失效 |

**反例 5 条**（`coord01-partition-lease.test.ts`）：
① 分区键空值拒绝；② 同分区竞争 ⇒ 后者 `held-by-other`；③ 过期接管 ⇒ token 1→2；
④ **旧消费者迟提交 ⇒ `assertIsCurrentOwner` 为 false**（fencing 的唯一意义）；⑤ 释放后旧 token 失效且新 token 递增到 3。

**本片尚未接线**：租约目前是独立原语，**没有生产消费者**——它要等"状态更新短事务"落地后由协调器使用。
因此 **COORD-01-02 仍为 pending**，不虚报完成。

**下一步**：实现"接收入库 → 短事务内 CAS 更新权威状态 → 记 applied + 置待唤醒标志"，并在事务内先
`assertIsCurrentOwner`（这才是 fencing 生效处），随后接调度重评估。

### COORD-01-02 进展（2026-11-11 目标轮 2）：短状态事务（fencing + 幂等 + CAS + 待唤醒）

| 交付 | 说明 |
|---|---|
| `CoordinationStateTransactionStore.applyMessage` | 顺序固定：① `assertIsCurrentOwner` → ② 幂等（同 `messageIdentifier` 复用结论）→ ③ CAS（`expectedStateVersion` 不符 ⇒ `stale`）→ ④ 状态与幂等记录**同一次原子写**，并 `pendingWakeCount + 1` |
| `ensurePartitionState` / `readState` | 分区状态持久化（`schemaVersion`、`stateVersion`、`snapshot`、`appliedMessages`、`pendingWakeCount`） |
| `readPendingWakeCount` | 唤醒是**可重复信号**（只读、不清零），对应卡 §4.5"重算 ready set 而非再启动一次任务" |

**反例 5 条**：① 首次应用 applied + 唤醒计 1；② 同消息重复投递 ⇒ `idempotent-replay` 且**唤醒不重复计**；
③ 版本不符 ⇒ `stale` 且状态不变；④ **旧 fencing token ⇒ `not-owner`**（事务内先校验所有权）；
⑤ 崩溃恢复：新实例读回 `appliedMessages` 与唤醒计数，重放不重复应用。

**仍未接线**：协调器尚未由反馈进程/应用装配调用（当前是两个可组合原语 + 用例）。
⇒ **COORD-01-02 仍 pending**。下一步：把"入库消息 → applyMessage → 重算 ready set"接进真实消费路径，
并补失败退避（1/2/4/8/16 秒、单轮最多 5 次、持久计数）与三状态查询入口。

### COORD-01-02 进展（2026-11-11 目标轮 3）：消费步把三块接成一条链

| 交付 | 说明 |
|---|---|
| `MailboxJournal.listPendingApplication` | 只列**尚未 applied** 的消息，按入池序号升序（已应用不再返回，避免重复处理） |
| `CoordinationMessageConsumer.runConsumptionStep` | 入库消息 → 取/续分区租约 → 逐条短事务应用 → 回写 `applicationState` → 返回唤醒信号 |
| 失败隔离 | 单条 `stale / not-owner / not-found` 记 `blocked` 并继续下一条，**不阻塞同分区其它消息** |
| 无消息调用/长等待 | 步内不调模型、不跑工具、不等待授权（卡 §4.2） |

**反例 4 条**：① 两条消息都应用并请求唤醒；② 二次消费不再新增应用；
③ 租约被他人持有 ⇒ **一条都不处理**且消息仍待应用；④ **持有者死亡、租约过期 ⇒ 新消费者接手**（恢复语义）。

**一处自我纠正**：第 4 条我最初写成了"正常路径 blocked=0"的伪反例（断言恒真、测不到任何东西），已删除重写为真实的租约过期接管用例。

**仍待接线**：消费者尚未被反馈进程/应用装配调用（目前是可组合原语 + 用例）。
下一步：在反馈进程的消息处理处调用 `runConsumptionStep`，并把返回的唤醒信号接到 ready-set 重算。

### COORD-01-02 进展（2026-11-11 目标轮 4）：**装配接线完成**，并修掉一个真实平台缺陷

**接线**：`createApplicationRuntime` 现在构造并暴露
`coordinationMailboxJournal` / `coordinationMessageConsumer` / `coordinationPartitionKey`
（分区键 = `project:<项目>|scheduler:<主 Agent 个体系 ID>`）。反馈 journal 与反馈子进程共用 `stateDirectory`，
本地协调器读的是**同一个 journal**。

**顺带发现并修复的真实缺陷（Windows）**：
`MailboxJournal.journalFilePath` 直接用 `${recipientId}.json`，而协作收件人是 `agent:<id>`（含冒号）——
Windows 文件名不允许冒号，原子写 rename 抛 `EINVAL`，即**发给 `agent:<id>` 的消息根本无法入库**。
修复：对文件名做**可逆编码**（仅转义非法字符），普通 ID 文件名保持不变（既有 journal 兼容），
`listRecipientIds` 解码还原原始 ID。

**用例**：
- `coord01-coordination-wiring`（2 条，装配层）：分区键正确；真实 journal 消息经消费步应用，二次消费不重复应用；
- `coord01-journal-filename-encoding`（3 条）：冒号 ID 可入库并读回 / `listRecipientIds` 还原 / 普通 ID 文件名不变。

**COORD-01-02 仍差**：失败退避（1/2/4/8/16 秒、单轮最多 5 次、持久计数）、三状态查询入口、
以及把 `isWakeRequested` 接到真实的 ready-set 重算。

### COORD-01-02 进展（2026-11-11 目标轮 5）：失败退避 + 持久计数（§4.7）

| 交付 | 说明 |
|---|---|
| `CoordinationRetryStore` | 按分区持久化每条消息的 `attemptCount` / `nextAttemptAt` / `isBlocked` / `reason` |
| 退避曲线 | **1/2/4/8/16 秒**（`COORDINATION_BACKOFF_MILLISECONDS`），单轮自动尝试上限 **5 次** |
| `isEligibleForAutomaticAttempt` | blocked 或退避未到期 ⇒ 本轮跳过 |
| `recordSuccess` / `resetForExplicitRetry` | 成功清除；**只有显式重试**才让 blocked 消息恢复自动尝试 |
| 接线 | 装配层构造并传入消费者，`runtime.coordinationRetryStore` 可达；消费步按 eligibility 过滤，失败记 `recordFailure` |

**用例**：退避 4 条（首次 1 秒且当下不可试 / 第 5 次 blocked 后永不再自动试 / **重启不清零** / 成功清除 + 显式重试恢复）
＋ 消费者集成 1 条（已达上限的消息本轮 `attemptedMessageCount = 0`）。

**全量门禁**：首次跑出现 3 个失败（`provider-fake-server` 等），**隔离重跑 17 条全过**、再跑全量 **725 files / 4824 passed** ⇒ 判定为并发抖动，非本次改动引起。

**COORD-01-02 仍差**：三状态查询入口、`isWakeRequested` → 真实 ready-set 重算接线。

### COORD-01-02 进展（2026-11-11 目标轮 6）：三状态查询入口（§3）

| 交付 | 说明 |
|---|---|
| `MailboxJournal.readMessageStatusView` | 同时返回 **delivery**（`isDelivered` / `deliveredAtIso`）、**application**（`state` / `reason` / `targetStateVersion` / `attemptCount`）、**context**（`not-required/pending/delivered/unknown`）三块，禁止用一个布尔合并 |
| 缺省语义 | 未应用 ⇒ `applicationState.state = "pending"`；无上下文注入 ⇒ `not-required` |
| 未命中 | 未知消息/收件人 ⇒ **空数组**，不伪造记录 |
| 接线 | `runtime.readCoordinationMessageStatus(messageId?)` 经装配层可达 |

**用例 4 条（视图）**：未投递未应用三态独立 / **已投递但未应用仍为 pending**（投递≠应用）/ applied 带目标版本且 blocked 带原因 / 未知消息空数组。
**用例 1 条（装配）**：经运行时入口查询，应用前 `pending`、消费步应用后 `applied`。

**COORD-01-02 只剩一项**：`isWakeRequested` → **真实 ready-set 重算**接线（卡 §4.5）。

### COORD-01-02 收口（2026-11-11 目标轮 7）：唤醒 → 重算 ready set

| 交付 | 说明 |
|---|---|
| `CoordinationStateTransactionStore.markWakeConsumed` | 已消费唤醒计数**只推进不回退**，持久化 |
| `CoordinationWakeCoordinator.recomputeIfWakePending` | 有**新**唤醒才重算；**重算只读、不派发**（派发仍走既有租约与幂等接口）；重算抛错时**不推进计数**，下一轮重试 |
| 接线 | `runtime.coordinationWakeCoordinator` + `runtime.recomputeCoordinationReadySet({selectReadyTasks})`；ready-set 来源由调度器注入，**不在协调器里复制一套选择逻辑** |

**用例 5 条**：无唤醒不重算 / 有新唤醒重算一次并推进计数 / 同一唤醒重复调用不重算（幂等）/
**重算抛错不推进计数并能重试** / 重启后计数保留不重复消费。加 1 条装配层集成（消费→重算一次→再调不重算）。

**CHECKPOINT 状态**：COORD-01-02 → **implemented-unverified**（全部子项已接线且有反例；人工验收未做）。

### COORD-01-03 进展（2026-11-11 目标轮 8）：稳定重试身份（§3）

| 交付 | 说明 |
|---|---|
| `CoordinationSubmissionIdentityStore.submit` | 有 `requestIdentifier` 时按 **(来源, 请求 ID)** 判重并复用同一 `messageIdentifier` 与**恢复令牌**；无请求 ID 时**每次生成新身份** |
| `resumeByRecoveryToken` | 凭令牌找回提交记录（响应丢失/进程恢复） |
| 冲突处理 | 同请求 ID **异内容** ⇒ `conflict`，交回既有记录，**不覆盖** |
| 接线 | `runtime.resolveCoordinationSubmission(...)` / `runtime.coordinationSubmissionIdentityStore` |

**用例 5 条**：① **相同文本、无请求 ID ⇒ 两条独立消息**（禁止按文本猜测"这是重试"）；
② 同请求 ID 同内容复用身份与令牌；③ 同请求 ID 异内容冲突；④ 令牌可重放、未知令牌 null；⑤ 重启后仍复用。
加 1 条装配层集成（三种结果都经运行时入口取得）。

**本片边界**：身份原语已接线可调用，但**上游提交入口（主控指令）尚未改为携带请求 ID** —— 那需要用户消息标识的贯通，
属 03 后续切片，未做即不宣称 03 完成。

### COORD-01-03 进展（2026-11-11 目标轮 9）：身份贯通到指令派发 + 入队去重证据

| 交付 | 说明 |
|---|---|
| `sendSchedulerInstruction(missionId, instructionText, stableMessageIdentifier?)` | 提供稳定标识时**沿用同一身份**（重试不重复入队）；未提供则维持既有行为 |
| 运行时 `sendMissionInstruction(..., stableMessageIdentifier?)` | 透传通道打通（当前尚无调用方传入） |
| 证据 | `coord01-submission-enqueue`（2 条）：同一请求 ID 两次提交 → 同一 `messageIdentifier` → journal **仅 1 条**；不同请求 ID 但文本相同 → **2 条**（不按文本去重） |

**仍未做**：`handleUserMessage` 目前**不接受用户消息标识**（入参只有 `message` + 选项），因此运行时的派发调用**尚未传入**
稳定标识 ⇒ 身份贯通只到"通道就绪"，未到"生产数据流"。这是 03 的下一片，需先在输入层生成/接收用户消息标识。

### COORD-01-03 进展（2026-11-11 目标轮 10）：稳定身份贯通到**公开入口**

本轮核对到关键事实：`sendMissionInstruction` **不是内部调用**，而是运行时对外 API（`application-runtime` 返回对象 +
`public-sdk` 门面）——指令由 CLI/GUI 经它下发。

| 变更 | 位置 |
|---|---|
| `sendMissionInstruction(missionIdentifier, instructionText, stableMessageIdentifier?)` | `application-runtime` 类型 + 实现 + `public-sdk` 门面 |

**用例 2 条**（`coord01-instruction-identity-dispatch`，直接调用真实 `MainController.sendSchedulerInstruction`，
用记录型传输观察入队参数）：
① 同一 `stableMessageIdentifier` 两次 ⇒ `messageId` 与 `idempotencyKey` **完全相同**（重投不产生新身份）；
② 不传 ⇒ 两次身份**不同**（不误合并）。

⇒ 稳定重试身份的**通道已到公开入口**。仍需调用方（私有 UI/CLI）在"一次用户提交"里生成并复用该标识；
本卡不修改 GUI，该侧落地属其自身检查点。

### COORD-01-03 进展（2026-11-11 目标轮 11）：回复产物引用**与实际版本核对**（§3）

| 交付 | 说明 |
|---|---|
| `verifyReplyArtifactReferences` | 逐条比对"引用版本 vs 当前版本"，四态：`current / stale / missing / future` |
| 门禁规则 | 要求产物证明但**无引用** ⇒ `artifact-not-provided` 不通过；有引用但非 current ⇒ `artifact-not-current:<明细>` 不通过；**普通消息无引用仍合法** |
| 接线 | `runtime.verifyCoordinationReplyArtifacts(...)`（版本解析由调用方注入，**模型不得自证**） |

**用例 5 条**：无引用不通过 / 引用版本低 ⇒ stale / **引用版本高 ⇒ future（不得按"更新"放行）** / 产物不存在 ⇒ missing / 版本一致通过且普通消息无引用也通过。

**与既有能力的关系（核实结论）**：完成证据侧的版本核对已存在于 `task-accuracy-verifier`（`artifactRevision > producedAtRevision` 判陈旧）；
本模块补的是**协作回复的 `artifactReferences`** 这条路径，两者口径一致（低于当前版本即陈旧）。

**仍未做**：把该判定接进**审查/完成门禁的判定点**（当前仅运行时可调用，尚无门禁消费它）。

### COORD-01-03 进展（2026-11-11 目标轮 12）：产物证明门禁**接进消费路径**

| 交付 | 说明 |
|---|---|
| `FeedbackMessagePayload.requiresArtifactProof?` | 消息**显式声明**需要产物证明；默认不要求（既有流程行为不变） |
| `CoordinationMessageConsumer.artifactGate` | 应用前先核对引用版本；不合格 ⇒ 记 `blocked`（含原因）+ 计入退避，**不应用** |
| 装配接线 | 运行时按 `requiresArtifactProof === true` 进门禁；解析器来自 `options.resolveArtifactRevision`，**未提供即按解析不到处理（fail-closed）** |

**用例 4 条（门禁）**：无引用 ⇒ `artifact-not-provided` 且 `appliedMessages` 为空 / 引用陈旧 ⇒ `artifact-not-current` /
引用合格 ⇒ 应用 / 不要求证明的普通消息 ⇒ 不受影响。
**用例 1 条（运行时集成）**：显式要求证明且缺引用 ⇒ 运行时不应用、状态查询显示 blocked 与原因。

**仍未做**：审查/完成门禁（独立审查裁决、合并批准）尚未消费该判定；本卡只在**消费路径**设了门禁。
另：交办回执释放窗口、控制旁路、上下文准入仍属 03 未完成项。

### COORD-01-03 进展（2026-11-11 目标轮 13）：交办回执释放窗口（§5）

先核实：`InstructionWindowStore` 已有**执行完成回执**释放槽位 + 补位 + 重复/乱序/缺任务关联拒绝
（`released-with-backfill` / `stale-revision-rejected` / `duplicate-receipt-ignored` 等），
但**没有"交办回执"这一类**——此前只有终态回执能释放。

| 交付 | 说明 |
|---|---|
| `InstructionReceipt.receiptKind?: "dispatch" \| "completion"` | 缺省 `completion`（向后兼容）；`dispatch` = 交办回执 |
| 新状态 `handed-off` | 交办确认后进入该终态（**区别于 `completed`**），并纳入 `TERMINAL_STATES` |
| 交办失败 | 返回 `dispatch-failed-no-release`，**保留槽位**且不改终态（改成 failed 会让槽位统计误以为已释放却未补位） |
| 幂等 | 回执键含 `receiptKind`；重复交办回执 ⇒ `duplicate-receipt-ignored` |

**用例 4 条**：交办成功 ⇒ `handed-off` 且释放 / 交办失败 ⇒ 不释放且仍 `dispatched` /
重复交办回执只释放一次 / 执行完成回执仍走 `completed`（两类回执分开）。

**仍未做**：控制旁路、上下文准入接线（03 剩余两项）。

### COORD-01-03 进展（2026-11-11 目标轮 14）：控制旁路（§2/§5）

先核实：全仓库**没有**控制通道（`emergencyStop|controlChannel|cancelRequest` 零命中），本轮从零建立。

| 交付 | 说明 |
|---|---|
| `ControlBypassController` | 可信来源（user/system）的取消/暂停/撤权/紧急停止 ⇒ **立即**设置本地执行门禁 |
| 来源可信性 | **agent 来源一律拒绝**（模型不得自标 control 取得优先权） |
| 幂等 | 按 `eventIdentifier` 去重，重复控制只生效一次 |
| 在途处置 | `supports-cancel ⇒ confirmed-stopped`；`does-not-support-cancel ⇒ unsupported`；**`unknown` 绝不报成已停止** |
| 派发门禁 | `MainController.dispatchMissionTask` 首行检查 `controlBypass.isExecutionBlocked` ⇒ `reasonCode: "control-blocked"` |
| 接线 | 运行时构造并经 `MainController` 选项注入；`runtime.controlBypass` 可达 |

**用例**：旁路 6 条（立即阻止 / agent 拒绝 / 幂等 / unknown 不报已停止 / unsupported 仍阻止 / supported 才报已停止）
＋ 派发门禁 3 条（不受控不误拦 / 受控拒绝且原因正确 / 只影响目标 mission）。

**仍未做**：上下文准入接线（03 最后一项）。

### COORD-01-03 进展（2026-11-11 目标轮 15）：上下文准入（§5，**模块完成、装配未接**）

| 交付 | 说明 |
|---|---|
| `classifyContextAdmission` | 依据**本地可信字段**判定：显式 `requiresModelDecision` / 带未决问题 / 澄清与披露请求 ⇒ 需模型处理；其余（普通进度、摘要）⇒ `archive-only` |
| `ContextAdmissionController.admit` | 需模型处理 ⇒ 注入一次并记**注入回执**；重复 ⇒ `duplicate-injection-ignored`；`archive-only` ⇒ 不注入、**不请求续跑** |
| `isResumeRequested` | 固定 `false`——注入回执**不等于**续跑请求（续跑只能由调度决定） |
| `MailboxJournal.setContextDeliveryState` | 补上 `contextDeliveryState` 的**写入点**（此前只有字段无写入方） |

**用例 5 条**：普通进度只归档 / 未决问题与显式要求需模型处理 / 重复注入只记一次 / archive-only 不注入且无回执 /
**注入回执不影响 journal 的 applicationState**（两种状态分开）。

**诚实记录一处失败**：本轮把 `contextAdmissionController` / `admitCoordinationContext` 装配进运行时返回对象时，
字符串替换同时命中了**主控构造参数**与返回对象两处，随后按行删除又切掉了主控构造的收尾 ⇒ 语法错误。
已 `git checkout --` 整体回退该文件，**装配接线未保留**，本片只交付模块 + journal 写入点，运行时装配留待下一轮
（改用「先 read 精确行号、再单点插入、每次插完立即 typecheck」的方式重做）。

### COORD-01-03 收口（2026-11-11 目标轮 16）：上下文准入**装配完成**

上一轮回退的装配本轮重做并验证通过（改用**行号插入**，不再用字符串替换做结构改动）：

| 接线点 | 内容 |
|---|---|
| 构造 | `coordinationContextAdmission`（stateDirectory/coordination/context-admission） |
| helper | `admitCoordinationContext({recipientId,messageId})`：按本地可信字段分类 → 准入 → 注入成功则写 `contextDeliveryState = delivered` |
| 暴露 | `runtime.contextAdmissionController` / `runtime.admitCoordinationContext` |

**集成用例（装配层）**：带 `unresolvedQuestions` 的消息 ⇒ `injected`、`isResumeRequested=false`、
`contextDeliveryState=delivered`，且 **`applicationState` 仍为 pending**（两种状态分开）；
普通进度消息 ⇒ `archived-only`、`contextDeliveryState=not-required`（不注入、不唤醒）。

### COORD-01-03 五项全部完成 ⇒ **implemented-unverified**

稳定重试身份（贯通公开入口）/ 执行与产物版本核对（判定 + 消费门禁）/ 交办回执释放窗口 /
控制旁路（含派发门禁）/ 上下文准入（装配完成）。人工验收未做，故不标 done。

### COORD-01-04 进展（2026-11-11 目标轮 17）：故障注入（卡 §7）

| 用例 | 覆盖的崩溃窗口 |
|---|---|
| ① 状态已写、journal 未回写 | 恢复后**只 replay 不重复应用**：`stateVersion` 仍为 1、`appliedMessages` 仍 1 条、journal 由 pending 变 applied |
| ② 消费者死亡、租约过期 | 接管后**只应用一次**，`pendingWakeCount` 恰为 1 |
| ③ 进程重启后同消息再到达 | 依旧只应用一次（跨进程幂等） |

**顺带修掉一个真实缺陷**：`tryAcquire` 对**同一持有者**重复获取返回 `held-by-other` ⇒
持有者自己"再问一次租约"会被判成拿不到，崩溃恢复场景下直接卡死。
已改为同持有者**幂等复用**（不递增 fencing token），并保留"他人持有 ⇒ held-by-other"语义。
现有租约用例 5 条 + 故障注入 3 条全部通过。

**COORD-01-04 仍差**：并发/权限回归、真实应用入口与 tarball 隔离验证。

### 推送状态（如实记录）

`df10e0c3`（上下文准入装配）与本轮提交均**未能推送**：连续 10 次 `Connection reset by 20.205.243.166 port 22`。
按单阶段 5 次上限规则已停止重试，本地保留待下次合并推送。

### COORD-01-04 进展（2026-11-11 目标轮 18）：并发/权限回归 + **tarball 隔离验证**

**并发/权限回归**（`coord01-concurrency-permission-regression`，5 条）：
① 两个独立 store 实例（模拟两进程）竞争 ⇒ 后到者 `held-by-other`；
② **旧 fencing token 迟提交 ⇒ `not-owner`**（若两条都生效，此用例必红）；
③ agent 来源控制事件被拒；④ 产物门禁**无解析器时 fail-closed**；⑤ 信息类不注入上下文。

**包级验证**（`scripts/verify-coord01-package.mjs`）：
tarball（`npm pack --ignore-scripts`）→ 隔离目录 `npm install` → 只 import `node_modules/astarray/dist/public-sdk.js`：
未知消息返回空数组（不伪造）/ agent 控制被拒 / 可信控制生效 / 未知消息准入返回 `message-not-found` ⇒
`coord01-package: ok, failures=0`。

**为可达性补齐的公开入口**（此前 SDK 门面**完全没有**协调链路）：新增
`readCoordinationMessageStatus` / `applyCoordinationControlEvent` / `admitCoordinationContext` 三个门面方法。
消费循环（`runConsumptionStep`）**仍不对外暴露**——它属内部调度职责，包级只验证安全相关读写。

### COORD-01-04 收口判定

| 项 | 状态 |
|---|---|
| 故障注入 | ✅ |
| 并发/权限回归 | ✅ |
| 真实应用入口 | ✅ 经 SDK 门面可达 |
| tarball 隔离验证 | ✅ `coord01-package: ok` |

⇒ COORD-01-04 **implemented-unverified**（无人工验收）。COORD-01 四个检查点至此全部有生产接线与自动化证据。

## 审查报告 P1 修正（2026-11-16）：准入 ≠ 投递（第一步）

审查报告 `docs/reports/ARCHIVE_AND_WIRING_REVIEW_2026-11-16.md` 指出：
`context-admission.admit` 只写消息 ID/接收者/时间就返回 `injected`，
`application-runtime.admitCoordinationContext` 据此把 journal 写成 `contextDeliveryState = delivered`，
但消息正文从未进入任何模型请求——"已投递"是假的。

### 已修（本步）

| 改动 | 位置 |
|---|---|
| `admit()` 改为**只记准入**，恒返回 `isDelivered: false`，不再声称注入 | `orchestration/context-admission.ts` |
| 新增 `recordDelivered()`：必须有 `requestIdentifier` 证据，且准入回执存在 | 同上 |
| 回执结构新增 `admissionClass` / `deliveredAtIso` / `deliveryRequestIdentifier` | 同上 |
| 运行时准入只写 `contextDeliveryState = "pending"`（不再写 delivered） | `application/application-runtime.ts` |
| 反例 10 条（含"准入后 deliveredAtIso 为 null""未准入不得记录投递""缺证据抛错""重复投递保留首次证据"） | `tests/core/unit/coord01-context-admission.test.ts` |
| 集成断言改为 `pending`（原断言写死 delivered，属把缺陷当契约） | `tests/core/integration/coord01-coordination-wiring.test.ts`、`coord01-concurrency-permission-regression.test.ts` |

### 仍未完成（本检查点第二步）

- **把准入消息接进既有上下文装配/安全点投递路径**，使真实模型请求携带其正文；
- 请求成功后调用 `recordDelivered({requestIdentifier})` 并写 `delivered`；
- 反例需**捕获实际模型请求**，断言正文、来源、目标个体与版本，而非只断言状态字段；
- 在完成前，`contextDeliveryState` 对需要模型处理的消息会停在 `pending`——这是**如实状态**，不是回归。

## 审查报告 P1 修正（2026-11-16）：准入 ≠ 投递（第二步：真实请求携带）

### 调用链（真实生产路径）

```text
application-runtime
  └─ createCoordinationContextDeliveryPort({ journal, admissionController, partitionKey })
      └─ 传入 MainController options.coordinationContextDeliveryPort
          └─ MainController → MissionOrchestrator options
              └─ MissionOrchestrator → new WorkerAgent({ coordinationContextDeliveryPort })
                  ├─ collectPending({ recipientId: "agent:<agentInstanceId>" })
                  │     ⇒ 只取 contextDeliveryState === "pending"
                  ├─ formatCoordinationContextBlock(...) 拼进 systemPrompt
                  └─ 首个模型事件到达（请求已提交）后 markDelivered({ requestIdentifier })
                        ⇒ journal 写 "delivered" + 准入回执写 deliveredAtIso/deliveryRequestIdentifier
```

### 关键语义

| 项 | 处理 |
|---|---|
| 准入 | 只写 `pending`，不算投递（第一步已修） |
| 请求携带 | 区块带**消息标识 / 来源个体 / 任务标识 / 正文**，并声明"不是已完成的事实、不是用户发言" |
| delivered 时机 | **首个模型事件到达之后**（请求确已提交并开始返回），不是请求前、也不是装配时 |
| delivered 含义 | 只表示"这次提交的请求携带了该内容"，**不表示模型理解或任务完成** |
| 无 pending 消息 | 不注入任何区块（测试③） |

### 验证

`tests/core/integration/coord01-context-delivery-wiring.test.ts`（3 条）
**实际捕获模型请求的 `systemPrompt`**，断言正文、来源、任务、待处理标注均在其中；
并断言 journal 状态与准入回执同步变为 delivered、请求标识以 `worker-turn:` 开头。

全量门禁：**798 files / 5299 passed + 3 skipped，exit 0**。

### 仍未完成

- 主 Agent（非 Worker）路径的上下文装配统一（审查报告 P2 项，属检查点 4）；
- COORD 消费器生产调用（检查点 2）。

## 审查报告 P1 第三项：消费入口（2026-11-16，第一步）

### 核实结论（不是照抄报告）

```text
git grep 'runConsumptionStep' packages/core/src → 只有 coordination-message-consumer.ts 内的方法定义
```

确认：**生产代码没有任何调用方**。消费步只作用于协调器状态（`stateStore.applyMessage`），
而**权威任务状态**（任务链）由 `MissionOrchestrator` 在自己的执行循环内推进——
两者之间**不存在现成 API**，所以"消费 → 权威状态更新 → ready 重算 → 派发"这条链必须新建接缝。

### 已交付：可调用入口 + 应用标识

| 改动 | 位置 |
|---|---|
| `runConsumptionStep` 结果新增 `appliedMessageIdentifiers`（只给计数无法定位消息，也就无法核对状态迁移） | `orchestration/coordination-message-consumer.ts` |
| 新增 `runCoordinationConsumptionOnce()`：跑一次消费步，并把应用标识交给调用方 `onAppliedMessages` | `orchestration/coordination-consumption-runner.ts` |
| 反例 4 条：无消息不调用钩子 / 有消息交标识 / 租约被占一条不应用 / 钩子抛错须向上抛 | `tests/core/integration/coord01-consumption-runner.test.ts` |

设计约束（写死在模块注释里）：

- 本模块**不自行修改任务状态**，也不持有第二套任务真相；
- 只有 `appliedMessageIdentifiers.length > 0` 才调用钩子；
- 钩子抛错**向上抛出**，不静默吞掉"状态没推进"；
- 消费步只在执行期间持锁（长模型调用/工具执行不得占锁），测试③即按此前提构造。

### 仍未完成（检查点 2 的主体）

- **生产触发**：尚未接到反馈入库通知与启动恢复；
- **权威任务状态更新**：需要 `MissionOrchestrator` 侧开放"按任务标识推进状态 + 重算 ready set + 触发派发"的钩子（当前不存在）；
- 崩溃窗口、重复投递、旧执行反馈、跨进程竞争、重复唤醒的端到端验证。

**因此检查点 2 不能标完成**：现在只是把"可调用入口"和"应用标识"准备好，链路仍缺两段。

## 检查点 2 主体：权威状态与派发的真实接缝（2026-11-16 核查）

为免"抽错接口"，先定位**既有**权威状态与 ready set 的真实位置：

| 能力 | 真实位置 | 结论 |
|---|---|---|
| 任务级状态推进 | `orchestration/dag-scheduler.ts`：`finishTask` / `releaseTaskBackToPending` / `blockTaskForHumanDecision` / `cancelTask` / `reassignTask` / `unblockTask` | **存在**，是权威图状态 |
| ready set 重算 | 同文件 `scheduleRound()`（返回 `ScheduleAction[]`） | **存在**，调度器自己的入口 |
| 派发 | `MissionOrchestrator` 消费 `scheduleRound()` 的动作 | **存在** |
| 任务链持久化 | `MissionManager` 仅 `updateMissionStatus`（**mission 级**）+ 创建时 `writeTaskChain` | **无任务级持久化 API** |
| 消费入口 | 本轮新增 `runCoordinationConsumptionOnce()` | 就绪 |

**所以链路可以这样接（不需要另造调度器/任务存储）**：

```text
反馈入库/启动恢复
  → runCoordinationConsumptionOnce()            // 幂等消费 + 应用标识
  → onAppliedMessages(ids)                      // 交给调用方
  → 由消息的 taskIdentifier 定位所属 mission 的 DagScheduler 实例
  → scheduler.finishTask(...)                   // 权威图状态推进
  → scheduler.scheduleRound()                   // ready set 重算
  → MissionOrchestrator 既有循环派发            // 不另建派发器
```

### 缺口（需要设计确认，不能自行猜）

1. **消息 → 运行中 mission 的路由**：`onAppliedMessages` 只拿到消息标识，需要判定它属于哪个 mission 的
   `DagScheduler` 实例；当前没有"按 taskIdentifier 查运行中 orchestrator"的注册表。
2. **任务级状态的持久化**：DagScheduler 状态目前只在内存图里；进程重启后如何与任务链对齐，现有代码没有约定。

这两点一旦确定，接线是小的；但**在未确认前不动调度器**——改错会直接产生重复派发或状态丢失。

## 检查点 2 第二步：启动恢复消费 → 权威任务链（2026-11-16）

### 真实调用链（已接线）

```text
runStartupRecovery()                       // 既有启动恢复入口（application-runtime L4867）
  └─ missionManager.listMissionIds()       // 逐个 mission
      └─ runCoordinationConsumptionOnce({ recipientId: "scheduler:<missionId>" })
          ├─ 幂等消费（租约 + fencing + 退避）
          └─ onAppliedMessages(ids)
              └─ applyCoordinationMessageToTaskState(...)
                    └─ taskStore.updateTaskChain(missionId, revision+1)   // 权威任务链
```

### 新增能力

| 项 | 位置 | 说明 |
|---|---|---|
| 消费 → 任务链状态 | `orchestration/coordination-task-state.ts` | 只认 `success`/`failure`/`blocked`；其它类型 `status-unchanged` 不写盘 |
| 启动触发 | `application-runtime.runStartupRecovery` | 单个 mission 失败不影响其它 mission；失败不阻塞启动 |
| 接线守卫 | `tests/architecture/coord02-consumption-wiring-guard.test.ts` | 钉住"启动恢复真的调用消费"与"结果真的落到任务链" |

### 语义与安全边界

- **不新建任务**：找不到任务 ⇒ `task-not-found`；
- **不猜状态**：不认识的消息类型不动任务；
- **幂等**：已是目标状态 ⇒ 不写盘（避免重放造成 revision 抖动）；
- **并发安全**：写入走 `updateTaskChain` 的 revision 保护，旧写者会被 `stale-revision` 拒绝；
- **不占锁**：消费步只在执行期间持租约，不做长模型调用。

### 仍未完成

- **入库通知触发**（除启动恢复外的第二条触发路径）；
- **ready set 重算 + 派发的显式触发**：当前依赖各 mission 既有 orchestrator 循环；
- **崩溃窗口/重复唤醒的端到端验证**（需要进程级用例）。

## 检查点 2 第三步：消息入库通知触发（2026-11-16）

启动恢复之外的第二条触发路径已接上，并与启动恢复**共用同一实现**（避免语义漂移）：

```text
FeedbackTransport.onMessage                      // 既有入库通知点
  └─ AssistScheduler.onMessage
      └─ assistOptions.onCoordinationMessageIngested?.()      // 新：任何消息都通知，不只指令
          └─ MainController options.coordinationIngestionNotifier(missionId)
              └─ application-runtime.runCoordinationConsumptionForMission(missionId)
                  └─ 幂等消费 → 权威任务链状态更新（与启动恢复同一函数）
```

### 关键设计

| 点 | 处理 |
|---|---|
| 触发范围 | 该 mission 的**任何**反馈消息（不只是 `instruction`），因为专利「入库即消费」 |
| 阻塞风险 | 通知用 `void ... .catch(() => undefined)`，**不阻塞消息处理**；回调内 try/catch 兜住同步异常 |
| 语义一致 | 启动恢复与入库通知调用**同一个** `runCoordinationConsumptionForMission`，不存在两套逻辑 |
| 幂等 | 由消费层（租约 + 应用状态 + 退避）保证；重复通知不会重复应用 |

### 验证

`tests/architecture/coord02-consumption-wiring-guard.test.ts` 扩到 5 条，钉住：
运行时提供通知端口、主控制器真的转给 AssistScheduler、AssistScheduler 真的回调。

全量门禁：**801 files / 5312 passed + 3 skipped，exit 0**。

### 仍未完成

- **消费后主动触发 ready set 重算**（`scheduleRound()`）与派发；
- 进程级崩溃窗口/重复唤醒用例。

## 检查点 2 第四步：运行中 mission 必须打到调度器（2026-11-16）

### 核实结论（先说事实）

| 检查 | 结果 |
|---|---|
| `MissionOrchestrator` 是否重读任务链 | `git grep -c readTaskChain` ⇒ **0** |
| `DagScheduler` 是否读任务链 | 同上 ⇒ **0** |
| `scheduleRound()` 依据 | 仅**内存图** |

⇒ **只写任务链，对运行中的 mission 不可见**；此前"写链即闭合"的判断是错的。

### 修正后的路由

```text
消费应用 ⇒ 该 mission 是否在 activeOrchestrators 中？
  ├─ 是 ⇒ scheduler.completeTaskByTaskIdentifier(taskId, outcome)   // 内存图推进；其既有循环负责 scheduleRound + 派发
  └─ 否 ⇒ applyCoordinationMessageToTaskState(...)                  // 只写任务链，重启重建图生效
```

新增公开入口 `MissionOrchestrator.completeTaskByTaskIdentifier`（`dagScheduler` 是私有的，
且 `finishTask` 对未 claim 任务幂等忽略 —— 正好覆盖"旧执行反馈"）。

### 同时修正的错误映射：`blocked` 不存在

`FeedbackMessagePayload`（`core/types.ts:373`）**没有** `kind: "blocked"`；
任务 `blocked` 一律由调度器 `blockTaskForHumanDecision`（`mission-orchestrator.ts` 5 处调用）依据本地事实判定。
`resolveCoordinationTaskStatus` 里的 blocked 分支已删除，并加守卫禁止复现（守卫⑧）。

| 消息 kind | 任务链/调度器结果 |
|---|---|
| `success` | done |
| `failure` | failed |
| 其它（含臆想的 blocked） | 不改状态 |

### 验证

- `coord01-task-state-application.test.ts` 扩到 6 条（含"blocked 不改状态""failure 映射为 failed"）；
- `coord02-consumption-wiring-guard.test.ts` 扩到 8 条（含"先问运行中调度器再写链""主控制器用注册表""不得含 blocked 分支"）；
- 全量门禁：**801 files / 5317 passed + 3 skipped，exit 0**。

### 仍未完成

- 进程级崩溃窗口 / 重复唤醒的真实进程用例；
- 消费结果若为 `done` 但任务未被 claim（未派发），当前按幂等忽略——是否需要"未 claim 也落链"的语义待定。

## 检查点 2 收尾：并发反例暴露的真实缺陷（2026-11-16）

写"重复投递/并发/重复唤醒"反例时，**反例本身抓到了一个真实缺陷**：

### 缺陷：租约获取是 TOCTOU，不是原子操作

`CoordinationPartitionLeaseStore.tryAcquire` 原实现：

```text
读租约 → 判断无主/过期 → 写入租约
```

两个实例可能**同时**读到"无主"，各自写入后都认为自己是持有者 ⇒
同一条消息被应用两次（反例实测约 50% 概率失败）。

### 修复（两层）

| 层 | 修复 |
|---|---|
| 租约层 | 写入后**回读校验**：持有者或 token 不是自己 ⇒ `held-by-other`；并在回读前短暂让出（5ms），让并发写者落盘 |
| 应用层 | 应用前再查一次**已落盘的应用状态**，已 `applied` 直接跳过；**幂等重放不再计入 `appliedMessageIdentifiers`**（重放触发下游会造成重复副作用） |

### 验证

`tests/core/integration/coord02-consumption-process-race.test.ts`（3 条，连续 8 次全绿）：

| 用例 | 断言 |
|---|---|
| ① 重复投递 | 第二次应用列表为空（不重复触发下游） |
| ② 两个实例并发消费 | 合计只应用 1 次 |
| ③ 重复唤醒 | 权威任务链只发生 **1 次**写盘（第二次 status-unchanged） |

全量门禁：**802 files / 5320 passed + 3 skipped，exit 0**（`graph-change-deterministic-drill` 抖动一次，隔离重跑 3/3 通过）。

### 如实说明的局限

1. 5ms 让出是**缓解**而非证明：真正的原子性需要操作系统级文件锁或原子创建（`O_EXCL`）；
2. "两个进程"目前用**两个实例共享磁盘目录**表示（租约是文件级的，路径相同）；
   真正 `spawn` 子进程的用例需要构建产物，尚未做；
3. 现有防线是"租约回读校验 + 应用状态复查 + 任务链幂等"三层，任一层单独都不够。

## P1-1 返修（2026-11-17）：「消息已 applied，但权威任务状态未更新」的崩溃窗口

### 原缺陷（先确认，不是照抄）

消费器先写 `applied`（协调处理进度），外层回调**随后**才更新权威任务状态；
两步之间崩溃 ⇒ 消息"已应用"、任务状态没变；而幂等重放不再触发外层更新 ⇒ **永久漏处理**。

### 修复调用链

```text
runCoordinationConsumptionOnce
  └─ 对每条 applied 消息：
       1) ledger.recordIntent            // 持久化"准备更新业务状态"（先于任何业务写入）
       2) applyMessage(...)              // 权威状态更新（幂等）
       3) ledger.markCompleted / markFailed(原因) + 抛出
runStartupRecovery
  └─ drainCoordinationTaskApplications   // pending/failed 条目重放，补齐崩溃窗口
```

| 改动 | 位置 |
|---|---|
| 业务应用台账（意图/结论/原因，原子写，不存业务真相） | `orchestration/coordination-task-application-ledger.ts` |
| runner 改为逐条"意图 → 应用 → 回执"，失败留痕并抛出 | `orchestration/coordination-consumption-runner.ts` |
| 运行时：台账实例 + 权威更新函数 + 启动补齐 | `application/application-runtime.ts` |

### 反例（4 条，全部在改动前可复现失败）

| 用例 | 断言 |
|---|---|
| ① 意图已写、业务未做（崩溃点 1/2） | 重启 drain 后任务变 `done`、台账 `completed` |
| ② 业务已做、回执未写（崩溃点 2/3） | 重放后任务链**只写过 1 次**（幂等，不重复派发/释放） |
| ③ 业务更新抛错 | 台账 `failed` + 原因保留；重试成功后才 `completed` |
| ④ 两消费者竞争 | 只有一个业务更新（写次数 1），台账 `completed` |

### 边界（如实）

- `applied` 仍是**协调处理进度**，不等于权威业务状态已更新；两者现在由台账分开表达；
- 台账只记"做到哪一步"，**不存业务结论**，权威状态仍是任务链 + 调度器（未新建第二套）；
- SIGKILL 仍可能丢失"最后一次回执写"，此时表现为 `pending` ⇒ 重启补齐（不是丢失数据）。

全量门禁：**806 files / 5332 passed + 3 skipped，exit 0**。

## P1-2 返修（2026-11-17）：协调完成入口不得绕过权威完成门禁

### 原缺陷

`MainController.applyCoordinationTaskOutcome` 直接
`scheduler.completeTaskByTaskIdentifier → dagScheduler.finishTask`，
于是一条带 `success` 的协调消息就能把任务写成 `done`，**绕过** Worker 收口路径上的
完成收据校验与独立审查。

### 本步修复

| 改动 | 位置 |
|---|---|
| 纯判定门禁（来源/项目/mission/任务状态/审查状态/完成收据） | `orchestration/coordination-completion-gate.ts` |
| 运行时在**写权威状态之前**调用门禁；拒绝则记 `blocked` 并抛 `coordination-completion-rejected` | `application/application-runtime.ts` |
| 新错误码 | `core/errors.ts` |
| 反例 9 条 | `tests/core/unit/coordination-completion-gate.test.ts` |

### 判定规则（要点）

| 情形 | 结果 |
|---|---|
| 缺来源个体 / mission / 项目 | 拒绝（不默认绑定当前执行） |
| 来源不是该任务受派个体 | 拒绝（迟到/冒名反馈不得结算） |
| 项目与 mission 项目不一致 | 拒绝 |
| 任务不在 `running` | 拒绝（旧执行反馈） |
| 审查中 / 已有返修或通过结论 | 拒绝（协调入口不得改判） |
| `done` 但**没有完成收据** | 拒绝（success 文本/产物存在/退出码 0 都不是验收结论） |
| `failed` 且来源与受派一致 | 接受（只推进执行状态，不涉及验收） |

### 如实说明的未完成边界（重要）

1. **审查状态目前只按 `taskType === "review"` 判定为 pending**，尚未读取完成裁决存储
   ⇒ "已有返修/通过结论被覆盖"的保护**未完全生效**；
2. **尚未与 Worker 收口路径合并成同一套校验**：Worker 路径有自己的完成收据评估，
   本门禁目前只拦协调入口（要求 1 的"同一套校验"未达成）；
3. 因此本步只做到"**堵住绕过**"，没有做到"两条路径共用一套门禁"。

全量门禁：**807 files / 5341 passed + 3 skipped，exit 0**（`graph-change-deterministic-drill` 抖动一次，隔离重跑 3/3）。

### P1-2 补强（2026-11-17 第二轮）：审查状态改为读权威裁决

上一轮遗留的缺口之一：审查状态只按 `taskType === "review"` 猜，**没读完成裁决存储**，
导致"已有返修/通过结论被协调 success 覆盖"的保护形同虚设。

| 改动 | 位置 |
|---|---|
| 新增 `resolveReviewStateForCoordination`：`accepted` ⇒ accepted，`rejected` ⇒ rework，无裁决 ⇒ 审查型 pending / 其它 none | `orchestration/coordination-completion-gate.ts` |
| 运行时在门禁前读取 `completionVerdictStore.read(mission, task)` | `application/application-runtime.ts` |
| 补例 3 条（裁决映射、无裁决默认、已返修仍被拒） | `tests/core/unit/coordination-completion-gate.test.ts` |

现状：协调入口**不会**把已返修/已通过的任务改判；返修中的任务收到 success 仍被拒。

**仍未完成（不虚报）**：Worker 收口路径与协调入口**仍是两套校验**
（Worker 走 `evaluateCompletionReceipt`，协调入口走本门禁）。
"同一套权威完成校验"这一条要求尚未达成。

全量门禁：**807 files / 5344 passed + 3 skipped，exit 0**。

## P1-3 返修（2026-11-17）：「首个事件 = 请求已投递」的错误判定

### 原缺陷

`worker-agent` 在收到**任意首个 AgentEvent** 时就把协调消息标成 `delivered`。
但本地门禁拒绝、请求前取消、构造失败都不会有事件；反过来"有事件"也不等于"请求确实提交"。
`delivered` 因此可能是假的。

### 修复后的判定链

```text
runToolLoop
  ├─ 工作时段门禁 / 预算 / 取消 先判 ⇒ 拒绝时不发起请求（不触发提交回调）
  ├─ providerEventStream = runtime.run(...)
  └─ 仅在**未在请求前取消**时触发 onRequestSubmitted（提交证据）

WorkerAgent
  ├─ onRequestSubmitted ⇒ 记 hasSubmittedCoordinationRequest = true
  ├─ 收到首个事件 且 已提交 ⇒ markDelivered(recipient, ids, requestIdentifier)
  ├─ 已提交但一个事件都没有就失败 ⇒ markUnknown（结果未知，不冒充成功/未发送）
  └─ 未提交（门禁拒绝/取消/构造失败）⇒ 保持 pending，不批量确认
```

| 改动 | 位置 |
|---|---|
| 新增 `onRequestSubmitted` 生命周期钩子（门禁之后、取消则不触发） | `runtime/tool-loop.ts` |
| 投递判定改为「提交证据 + 确实开始返回」；失败未收到事件 ⇒ `unknown` | `orchestration/worker-agent.ts` |
| 端口新增 `markUnknown`（journal 写 `unknown`） | `orchestration/coordination-context-delivery.ts` |
| 反例 3 条（门禁拒绝 ⇒ pending；发起即失败 ⇒ unknown；请求前取消 ⇒ pending） | `tests/core/integration/coord01-context-delivery-wiring.test.ts` |

### 语义

- `delivered` = **该请求确实携带了这些消息正文并已开始返回**；不代表模型理解、也不代表任务完成；
- `unknown` = 请求已发起但无法确认结果（网络中断等）；
- `pending` = 尚未进入任何请求（门禁拒绝/取消/构造失败都留在这里）。

### 仍未完成（如实）

- **要求 7（只把已授权/版本适用/预算内的消息放进请求，未进入的继续等待）未实现**：
  当前仍是一次性取该个体全部 `pending` 消息，没有按预算/版本做**部分携带**；
- `worker-agent` 侧首次事件仍参与判定（但必须伴以显式提交证据），不是纯"提交即确认"。

全量门禁：**807 files / 5347 passed + 3 skipped，exit 0**。
（首轮门禁红在 `e2e01-provider-write-probe` / `obs01-diag-production-collection`，
原因是我的 `options.cancellationSignal.aborted` 未做空值保护——**真实回归**，已修并复跑绿。）

### P1-2 补强之二（2026-11-17）：抽出**单一**权威完成校验函数

之前两条入口各写一套（Worker 走 `evaluateCompletionReceipt`，协调入口走协调门禁）。
本步抽出 `evaluateAuthoritativeCompletion`：

```text
evaluateAuthoritativeCompletion
  ├─ 收据校验（仅在 isCompletionReceiptRequired 时；**复用** evaluateCompletionReceipt，不重写规则）
  └─ 协调门禁规则（来源=受派个体、任务 running、审查状态、收据存在）
       entryKind="worker"            ⇒ 跳过"消息必须自证 mission/project"两条
       entryKind="coordination-message" ⇒ 全量校验
```

| 改动 | 位置 |
|---|---|
| 共用校验函数（含入口种类） | `orchestration/authoritative-completion.ts` |
| 协调入口改用它 | `application/application-runtime.ts` |
| 补例 2 条（两入口各自输入） | `tests/core/unit/coordination-completion-gate.test.ts` |

**仍未完成（必须说明）**：`MissionOrchestrator.handleWorkerOutcome` 内部**仍直接调用**
`evaluateCompletionReceipt`，尚未改为调用共用函数。也就是说：
- "同一套规则"已经**存在**（一个函数覆盖两边语义）；
- 但 Worker 路径**还没接过去**，两条路径在代码上仍是两个调用点。

### 过程中发现的健壮性缺口（未修，记录）

`evaluateCompletionReceipt` 对**畸形收据**（缺 `missionIdentifier` 等）会 `.trim()` 崩溃，
而不是返回"收据不足"。收据来自本地 Worker，风险有限，但属于"坏输入导致异常"而非"拒绝"。

全量门禁：**807 files / 5349 passed + 3 skipped，exit 0**。
