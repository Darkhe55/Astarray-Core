# COORD-01：任务与反馈统一消费协调及恢复闭环返修

日期：2026-11-11。状态：pending。性质：现有编排接线返修，非新增 Agent 框架，非实验性能力。

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
| COORD-01-02 | 反馈可靠接收→状态幂等更新→调度重评估；分区、租约、短事务、失败恢复及查询入口 | pending |
| COORD-01-03 | 稳定重试身份、执行/产物版本、交办回执释放窗口、控制旁路与上下文准入接线 | pending |
| COORD-01-04 | 故障注入、并发/权限回归、真实应用入口和 tarball 隔离验证，更新相关卡状态与证据索引 | pending |

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
