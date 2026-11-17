# WIRING-04：可靠消费、请求投递与上下文生产接线返修

日期：2026-11-17。状态：pending。核对基线：`82671d02`。本卡是实施规格，不是完成声明。

## 0. 给只看到局部代码的实施者

产品的任务真相是个体任务偏序集及其 mission 执行映射，不是协调日志。反馈可靠入库不代表业务应用，业务应用不代表模型阅读。主 Agent 只读；次级组织执行与审查；执行者自报不能代替最终验收。记忆按个体隔离，但上级可以在有权范围内显式附加其他个体的选定资料。资料引用不等于授权或新指令。上下文缩减采用节点退出与按需读取，不得有损截断必要内容。

局部修复必须遵守以上事实。不能为了使一个单元测试通过而增加默认成功值、伪造版本/来源、绕过门禁、删除失败断言或把内部状态等同于用户可见完成。

前驱与复用：[COORD-01](COORD01_TASK_FEEDBACK_CONSUMPTION_REPAIR.md)、[COORD-02](COORD02_MESSAGE_VERSION_AND_AUTHORIZATION_STAMPING.md)、[COORD-03](COORD03_CONTEXT_PACK_ASSEMBLY_AND_CLOSED_NODE_RECALL.md)、[ALIGN-03](ALIGN03_EXECUTION_REVIEW_FEEDBACK.md)。本卡补齐调用链并明确 COORD-03 的接线选择；不重写这些卡的全部内容。

## 1. 固定范围和实施顺序

| 检查点 | 必做结果 | 状态 |
|---|---|---|
| WIRING-04-01 | 消费意图先持久化、业务应用可重放、旧状态可对账 | in_progress（顺序已改；原子单元/迁移/双进程待做） |
| WIRING-04-02 | 请求投递事实由适配器提供，回执准确且有界 | pending |
| WIRING-04-03 | 完成反馈统一门禁及生产版本来源闭合 | pending |
| WIRING-04-04 | 按映射读取当前任务包、授权依赖及固定版本 | pending |
| WIRING-04-05 | 显式关闭节点回访、真实请求装配与整链验收 | pending |

按 01 → 02 → 03 → 04 → 05 顺序，每轮一个检查点，超过三小时拆分。不得把“纯判定完成”作为“生产接线完成”。已有实现先读调用链并复用。公共装配文件遇并行施工，只阻塞冲突部分，不能覆盖他人修改。

本卡只涉及核心、CLI、SDK、公开测试及文档。不新增界面、第三方依赖、远端服务或付费模型调用；不修改系统权限、不改变独立审查默认开关、不清理历史或备份。

## 2. WIRING-04-01：消除确认早于业务意图的窗口

### 现状与涉及位置

`coordination-message-consumer.ts` 先写 journal applied；`coordination-consumption-runner.ts` 返回后才写 `coordination-task-application-ledger.ts` 意图。`mailbox-journal.ts:listPendingApplication` 排除 applied。此时崩溃会导致消息与台账两边都不再处理。

### 必须实现的顺序

1. 读取消息并校验可信来源、项目/个体、任务版本与执行尝试，取得分区租约；保留消息原文与内容指纹。
2. **先**写持久化业务意图，标识至少绑定项目、接收者、mission、task、executionAttempt、messageIdentifier 和内容指纹。此操作成功前不得把 journal 标成 applied。重复同键同内容复用；异内容拒绝。
3. 通过权威任务控制器应用；同消息幂等证据与任务状态变更必须处于同一个原子提交单元。若需要调度唤醒，将待唤醒标记一并持久化，唤醒只重算 ready set，不直接重复启动工具。
4. 权威提交成功后把意图标 completed，最后更新 journal applied。任一回执失败可重试，不能再次产生业务副作用。
5. 启动恢复扫描 pending/failed 意图，按原版本重新核验并补做；completed 意图只补 journal/唤醒回执。权限被撤销或版本已改变时 blocked/stale，不盲目恢复。

`applicationState=applied` 统一表示权威业务动作已完成，不能继续解释为“协调器碰过这条消息”。信息类无业务修改时可在可靠归档后完成该类消费，但必须记录 archive-only 处理类型，不制造任务状态变更。

生产 runner 的 ledger、业务应用端口和定位信息不得可选；纯函数测试单独提供假端口，不能保留缺端口仍成功的生产分支。消费器不能先批量确认，再在外层写意图。方法返回明确 applied/already-applied/blocked/stale/rejected，空返回值不视作成功。

### 旧状态迁移

增加 schemaVersion 与一次性迁移对账：旧 journal applied 但无业务意图时，记录 needs-reconciliation。仅有权威任务的同消息应用证据才能补 completed；证据不足保留 blocked 并报告，不自动重放可能有副作用的旧消息，不根据任务恰好 done 推断该消息已经应用。迁移前备份，失败不覆盖旧文件。

### 验收反例

在每两个持久化步骤之间注入进程终止；尤其必须覆盖“原消费器确认之后、原 runner.recordIntent 之前”的历史故障点。恢复后既不漏业务更新也不重复派发。另测：状态成功回执失败、磁盘满、业务异常、双进程租约接管、旧 fencing token、旧执行尝试、缺依赖端口、旧 applied 无意图。仅模拟内存异常不代替至少一条真实子进程终止/恢复测试。

## 3. WIRING-04-02：请求投递事实与回执

### 禁止的推断

`runtime.run()` 返回异步迭代器、未同步抛错、收到本地 runFinished、工具循环开始，都不能证明外部请求已发出。不得用这些信号调用 markDelivered。当前 Worker 逐事件重复写回执也必须移除。

### 固定协议

在现有 AgentRuntime 协议增加结构化请求生命周期通知，具体命名可沿用现有类型，但必须表达以下事实：

- prepared：已确定本轮实际请求内容与 requestIdentifier，尚未交给传输层。
- dispatched：具体适配器已经调用传输 API；不保证对端收到。
- acknowledged：收到与该 requestIdentifier 对应的对端协议响应（包含 HTTP 错误响应，但不包含本地构造异常）；只证明对端对请求作出响应，不表示业务成功或模型理解。
- failed-before-dispatch：未调用传输 API。
- outcome-unknown：已调用传输 API，但无可靠对端响应即断开、取消或超时。

内部生命周期不是模型可伪造的控制事件。网络适配器在真实传输边界发布；mock 只能发布标有 mock 来源的测试事实。没有能力提供该证据的适配器返回 unknown，不降级用首事件猜测。

上下文回执映射固定：prepared/failed-before-dispatch 保持 pending；dispatched 尚不标 delivered；acknowledged 标 delivered；outcome-unknown 标 unknown。这里 delivered 是保守的“请求携带内容且获得对端响应”，不是提供商保证模型已阅读。业务 HTTP 拒绝由独立请求状态表示，不混成任务成功。

请求装配时固定实际携带的消息 ID 集合、目标个体、消息版本、requestIdentifier 与载荷指纹；只确认该集合，不确认本轮未装入或之后到达的消息。回执按请求+消息幂等，只写一次；多次模型迭代各自独立记录。先写可恢复的请求确认记录，再更新邮箱投影；投影失败启动时补写，不靠重发模型请求补偿。unknown 不触发自动重跑业务，沿既有恢复对账策略处理。

涉及 `runtime/tool-loop.ts`、Worker、`coordination-context-delivery.ts`、具体 Provider 适配器及 runtime 类型。补真实捕获请求的本地假服务测试：请求前门禁/取消、迭代器首次 next 前错误、正常响应、HTTP 拒绝、发起后断网、部分消息入请求、重复事件、回执写失败。每条断言请求次数与正文、来源、消息版本，不只断言标志。

## 4. WIRING-04-03：统一完成门禁不得停在局部判定

复用 `authoritative-completion.ts`、现有完成收据和独立审查，不复制规则。追踪到运行时、活动调度器以及非活动 mission 持久状态三条入口。

- 业务消息的 source/project/taskRevision/executionAttempt 必须由受信执行登记和发送封装填入，不能从任意模型载荷取得即信任。
- 校验读取持久化当前执行身份；不能以 claimed/running、时间戳或任务 ID 代替执行尝试。
- 完成资格由同一门禁产生，权威提交时再次核对期望版本。没有资格不得调用底层 finishTask(done)。内部完成 API 改为接收受控校验结果或在内部校验，防止新增调用方绕过。
- 审查拒绝、等待人工、必要操作未成功时，反馈不能直接将任务置为最终 done；缺字段 blocked，不补默认通过。
- 幂等记录绑定具体状态变更，不能把未应用/被拒也登记为业务成功。

反例必须经过生产反馈入口：旧 attempt 完成新任务、假来源、错误项目、缺收据、过期产物、审查拒绝、重复成功、非活动 mission 恢复。测试需断言任务持久状态和下游派发，不只测 evaluate 函数。

## 5. WIRING-04-04：固定选择 COORD-03 方案 C

**本卡明确选择既有 missionTaskSequenceMapStore 映射方案 C**，不再等待 A/B/C 裁决。个体任务序列是上下文包权威来源，mission 节点不保存第二份可独立更新的包正文。

调用链：任务序列发布/修订并固定输入版本 → mission 投影同时建立精确节点映射 → createContextPromptProvider 通过映射解析 AgentTaskNode → 读取当前任务包及显式依赖引用 → 纯策略判定 → 预算 → 实际请求。

映射必须精确到 mission task 与 agent task，不能仅凭 mission 关联整条序列后猜任务。一个序列任务分解成多个 mission 节点时，各节点带明确来源及选定输入引用；缺必要映射阻塞该任务，不能按名称、最近任务或固定 T-001 猜。确实不绑定包的旧任务可无包运行，但需明确 no-pack-declared；不能将“声明有包却查不到”当作无包。

### 包版本与授权

1. 当前任务包与依赖包都固定 packIdentifier + revision + 内容哈希；禁止当前包 pinnedRevision=0 占位。复用现有版本存储；若无历史版本存储，新增不可变版本对象及索引，不另建可变任务真相。
2. 读取指定旧版本，最新版发生变化只产生 revision-advanced 提示，不自动换版本、不单纯因此拒绝有效旧版本。固定版本缺失/哈希不符则必要输入 blocked，可选输入省略并说明。任务发布方显式修订才能更换绑定版本。
3. 不递归继承全部依赖。只有当前任务声明的引用进入装配；只读取选定成员/产物，不加载兄弟完整档案。
4. 不同属主不必然拒绝：本地授权判定允许当前执行个体读取这个项目、来源个体和指定版本/条目时可以附加。没有授权拒绝。上级选择附件须在上级自身可授予范围内；跨项目仍受既有只读授权规则限制。
5. 显式引用不是授权，包里的 sourcePriority 也不是凭证。权限与发布身份从可信任务登记/授权记录解析，不依靠可编辑包字段自报。

### 冲突固定语义

- 同包 ID/版本/条目/内容哈希重复才直接去重，保留全部来源。不同内容或不同任务约束不能只因摘要相似而去重。
- “全局用户任务最高优先级”是调度规则，不等于旧资料中的 user 文本可以覆盖当前任务要求。
- 只有可信发布者明确且有权的 supersedes 修订关系才能消解指令冲突；无该关系保留冲突并升级直属上级，不按包位置或 user>agent>tool 自动覆盖。
- 事实冲突不自动裁决。关键冲突阻塞受影响任务，可选冲突内容不注入正文，返回待处理引用与原因。
- 必要条件/任务/验收/必要依赖超预算时拆分或阻塞；可选内容暂存，仅传引用；不能截断或摘要替换必要原文。

反例：获授权跨个体能读、未授权不能读；绑定旧版本而新版本存在；固定版本丢失；伪造 user 优先级；无明确修订冲突；映射缺失/歧义；同名任务不串包；完整请求确实携带选定正文与来源。

## 6. WIRING-04-05：关闭节点回访与装配

默认显式按需回访，不自动相似度召回正文。预先声明的必要依赖可读取其指定内容；其他关闭节点仅提供最小候选引用，Agent 经已有读取权限发起请求，无需每次人工确认，越权才升级授权。

复用既有 recall 工具/控制器与时间锁：请求绑定节点 ID、来源个体、固定 revision、读取范围及当前任务。校验权限/版本/预算后，结果进入现有工具响应，或登记为当前任务选定的 recalledContextBlocks；不得两处重复注入。回访结果标明摘要或原文范围、来源及缺失信息。

闭合验收：读取不改变关闭状态、不恢复任务、不修改原始档案；未请求正文不自动注入；候选仅基于显式引用/依赖/产物关联；无需向量模型。主 Agent missionId=null 的历史续接不由本卡伪造 mission 来解决，保留独立未完成项，不将其包装成已统一上下文。

## 7. 文档、验证与收口（必须执行）

每检查点先反例后实现，变量名可读，时间变量带单位。必须同步本卡、COORD-01/02/03 对应项及 PLAN_STATUS 当前有效状态，旧“完成”声明按实际证据更正但保留历史。相关架构/API 文档记录上述状态语义；README 仅修改真实用户可见用法，不加入施工日志。

共享文件并行冲突时创建独立 `docs/reports/STATUS_UPDATE_WIRING04_<日期>.md`，给出待合入条目，不覆盖他人工作，不以缺文档授权为由省略。实现注释须解释入口前置条件和不可绕过的门禁，不能保留与行为相反的旧注释。

运行定向反例、npm run check、安全与状态机专项；用安装后的 tarball 公共入口验证反馈入库→业务状态→调度，以及任务映射→包/回访→真实模型请求载荷。使用本地假 Provider，无真实付费模型。故障测试必须证明恢复，不仅证明抛错；并发至少一条真实双进程，不用两个对象代替全部跨进程证据。

交付报告逐项列：变更前后调用链、持久化顺序、权限来源、测试命令/退出码、包文件哈希、文档更新、提交号、剩余限制。只按显式路径提交自身文件，各检查点独立提交并按仓库纪律推送。只有所有必做项和生产入口验证通过才可整卡 done；模型真实体验、平台未验证等范围如实单列，不用测试数量覆盖未闭合问题。

## 8. 施工记录：WIRING-04-01 第一步（2026-11-17）

### 已改（顺序修正）

| 项 | 内容 |
|---|---|
| 消费器新增 `businessIntentPort`，在 `applyMessage` **之前**写意图 | `orchestration/coordination-message-consumer.ts` |
| 意图写入失败 ⇒ 不应用（异常上抛；journal 不标 applied） | 同上 |
| 意图冲突（同键异内容）⇒ 记 `blocked` 且不应用 | 同上 |
| 台账 `recordIntent` 增加内容指纹/执行尝试，返回 `recorded`/`reused`/`conflict` | `orchestration/coordination-task-application-ledger.ts` |
| 运行时把台账适配成意图端口 | `application/application-runtime.ts` |

### 反例

`tests/core/integration/coord01-consumption-runner.test.ts`：

- ⑬ 意图写入抛错 ⇒ journal 仍列该消息为待应用（未标 applied），不产生权威状态；
- ⑭ 意图冲突 ⇒ `appliedMessageCount=0`、`blockedMessageCount=1`。

### 本轮**未完成**（不得当作 01 已闭环）

| 必做项 | 现状 |
|---|---|
| 意图与权威状态**同一原子提交单元** | 未实现：仍是"意图 → 应用"两步 |
| 启动恢复扫描 pending/failed 意图并按原版本补做 | 未实现（现有 drain 只看台账，不校验版本/权限） |
| 旧状态迁移（applied 无意图 ⇒ needs-reconciliation、备份、不自动重放） | 未实现 |
| 生产 runner 端口"不可选" | 未实现：consumer 端口仍是可选（测试需要），仅运行时必传 |
| 至少一条真实子进程终止/恢复测试 | 未实现 |
| mission 未知时的意图 | **已知限制**：运行时返回 `reused` 沿用旧行为，未按 blocked；需生产方补 mission 后收紧 |

### 门禁

**817 files / 5398 passed + 3 skipped，exit 0**。

## 9. 施工记录：WIRING-04-01 第二步（2026-11-17）

### 新增：恢复对账（以权威证据为准，不重放）

`orchestration/coordination-consumption-runner.ts` 新增 `reconcileCoordinationTaskApplications`：

```text
对每个 pending/failed 意图：
  权威状态里**已有**该消息的应用证据 ⇒ 只补 completed（绝不重放业务）
  没有证据 ⇒ 才调用应用端口补做；成功记 completed，失败保留原因
  缺应用端口 ⇒ 记失败并写明"不冒充完成"
```

对应卡内要求：

> 启动恢复扫描 pending/failed 意图，按原版本重新核验并补做；
> completed 意图只补 journal/唤醒回执。

### 反例

`tests/core/integration/coord01-business-application-crash.test.ts`：

- ⑤ 已有权威应用证据 ⇒ `reconciledFromEvidenceCount=1`，应用端口**调用 0 次**，条目变 `completed`；
- ⑥ 无证据 ⇒ 调用一次应用端口并记 `completed`。

### 仍未完成

| 必做项 | 现状 |
|---|---|
| 把 `reconcileCoordinationTaskApplications` 接进 `runStartupRecovery` | **未接**：函数已就绪，运行时启动恢复仍只做 `drainCoordinationTaskApplications` |
| 按**原版本/权限**核验（revision、执行尝试） | 未做：目前只按消息标识核对应用证据 |
| 旧状态迁移（applied 无意图） | 未做 |
| 原子提交单元 | 未做：仍是"意图 → 应用 → 回执"三步 + 对账 |
| 真实子进程终止/恢复 | 未做 |

### 门禁

**817 files / 5400 passed + 3 skipped，exit 0**。

## 10. 施工记录：WIRING-04-01 第三步（2026-11-17）

### 启动恢复改为对账

`runStartupRecovery` 里的 `drainCoordinationTaskApplications`（无条件重放）已替换为
`reconcileCoordinationTaskApplications`：

```text
isAppliedInAuthoritativeState(messageIdentifier)
  = coordinationStateStore.readState(coordinationPartitionKey)
      .appliedMessages.some(m => m.messageIdentifier === messageIdentifier)
```

- 分区状态文档的 `appliedMessages` 与 `snapshot` 由 `writeAtomicJson` **同一原子写入**
  ⇒ 这条证据与"任务状态已变更"天然同源；
- 有证据 ⇒ 只补 `completed`；无证据 ⇒ 才补做；两者都不重复产生业务副作用。

### 仍未完成

| 必做项 | 现状 |
|---|---|
| 该对账的**产品路径反例**（启动恢复真的不重放） | **未补**：目前只有函数级反例 ⑤⑥，运行时入口未单测 |
| 按原 revision / 执行尝试核验 | 未做：只按消息标识核对证据 |
| 旧状态迁移（applied 无意图 ⇒ needs-reconciliation + 备份） | 未做 |
| 真实子进程终止/恢复 | 未做 |
| mission 未知时意图 | 已知限制（沿用旧行为） |

### 门禁

**817 files / 5400 passed + 3 skipped，exit 0**。
