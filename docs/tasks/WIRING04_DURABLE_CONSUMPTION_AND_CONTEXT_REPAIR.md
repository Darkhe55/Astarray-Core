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

## 11. 阻塞点：对账的产品路径反例需要真实 mission 任务链（2026-11-17）

尝试写"启动恢复不重放"的产品路径反例（`wiring04-startup-reconciliation`）时受阻：

| 观察 | 含义 |
|---|---|
| 只 `enqueue` 一条带 `missionIdentifier` 的协调消息，等 20s 仍**没有**任何意图写入 | 启动恢复的消费只遍历**已知 mission**（来自任务链存储）；没有任务链就没有 mission 可遍历 |
| 因此 `applyMessage` 从未被调用 | 不是对账逻辑问题，是**测试前置缺失** |

### 已回退

该测试文件**未提交**，已删除（不留半成品/不留失败用例在网络恢复后混进门禁）。

### 下一步第一条动作（解除阻塞）

给该反例准备**真实 mission 任务链**：用现有 e2e harness（`e2e01-provider-write-probe` 或
`coord01-coordination-wiring`）里创建 mission 的入口，先产生一个带任务的 mission，
再 enqueue 协调消息、等待应用、把台账改回 pending、调用 `runStartupRecovery()`，
断言：条目变 `completed` 且 `appliedMessages` 数量不变。

### 当前状态

| 项 | 状态 |
|---|---|
| 对账函数 | ✅ 实现 + 函数级反例 ⑤⑥ |
| 启动恢复接线 | ✅ 已接（读分区状态 `appliedMessages`） |
| 产品路径反例 | ❌ **阻塞**（缺 mission 任务链 fixture） |

## 12. 施工记录：WIRING-04-01 第四步（2026-11-17）

### 产品入口反例（解除上一节的阻塞，换了一条更小的路）

不再驱动整条 mission，而是**直接构造崩溃后的磁盘现场**（台账 pending + 分区状态已应用），
再调用真实入口 `runtime.runStartupRecovery()`：

| 断言 | 结果 |
|---|---|
| 台账条目变 `completed` | ✅ |
| 分区状态 `appliedMessages` 数量**不变** | ✅（没有第二次业务应用） |
| `stateVersion` 不变 | ✅ |

理由：启动恢复的对账只依赖这两份持久化证据，造 mission 只会引入与对账语义无关的调度噪声。
（先前"必须真实 mission"的判断过于保守，已在本节更正。）

### 旧状态迁移（一次性）

新增 `orchestration/coordination-legacy-migration.ts`：

```text
遍历 journal 所有收件人 → 消息 applicationState=applied 且台账无记录
  有权威同消息应用证据 ⇒ 补 completed
  无证据 ⇒ 标 needs-reconciliation（原因写明"不自动重放"）
  已有台账记录 ⇒ 不动
  迁移前先用 atomic-json 写 `.pre-migration.bak`
```

运行时在 `runStartupRecovery` 里**一次性**执行（标记文件 `coordination/legacy-migration.done`）；
迁移失败不写标记（下次重试），且不阻塞启动。

反例 `tests/core/integration/wiring04-legacy-migration.test.ts`（4 条）：
无证据 ⇒ needs-reconciliation；有证据 ⇒ completed；备份存在且含旧内容；已有记录不被改写。

### 教训（过程记录）

首次实现用了 `writeFile` / `copyFile`，被 `destructive-file-api-guard` 拦下（白名单外禁止直接写文件）。
改为全部经 `writeAtomicJson`，守卫通过——**这是守卫应有的行为，不是绕过**。

### 仍未完成

| 必做项 | 现状 |
|---|---|
| 按原 revision / 执行尝试核验 | **阻塞**：消息结构无 `taskRevision` / `executionAttempt`（见 COORD-02） |
| 意图与权威状态同一原子提交单元 | 未做（三步 + 对账；要同一单元需合并两个存储的写边界） |
| 真实子进程终止/恢复 | 未做 |
| 无包/无 mission 的历史数据边界 | 已知限制未变 |

### 门禁

**819 files / 5405 passed + 3 skipped，exit 0**。

## 13. 施工记录：WIRING-04-02 第一步（2026-11-17）

### 请求生命周期（替代"首事件=已投递"）

`core/types.ts` 新增：

```ts
type RequestLifecycleEventKind =
  | "prepared" | "dispatched" | "acknowledged"
  | "failed-before-dispatch" | "outcome-unknown";
```

| 发布者 | 发布什么 | 位置 |
|---|---|---|
| 工具循环 | `prepared`（请求已装配）与 `failed-before-dispatch`（请求前已取消，**不调用传输 API**） | `runtime/tool-loop.ts` |
| OpenAI 兼容适配器 | `dispatched`（调用传输前）、`acknowledged`（拿到对端响应，**含 4xx/5xx**）、`outcome-unknown`（已发出但无响应） | `runtime/openai-compatible-runtime.ts` |
| Worker | 只按这些事实落回执：`acknowledged ⇒ delivered`；失败且无 acknowledged ⇒ `unknown`；其余保持 `pending` | `orchestration/worker-agent.ts` |

同时移除了"逐事件重复写回执"（一次请求一份回执）。

### 反例

| 用例 | 断言 |
|---|---|
| `tests/core/unit/request-lifecycle-adapter.test.ts` ① | 正常响应：`dispatched → acknowledged` |
| ② | HTTP 403 也算 `acknowledged`（对端作答 ≠ 业务成功） |
| ③ | 传输层抛错：`dispatched → outcome-unknown`（不是 delivered） |
| `coord01-context-delivery-wiring` ② | 请求被确认后才 `delivered`，回执带回 `worker-turn:` 请求标识 |
| ⑤ | 发起即断网 ⇒ `unknown`，不冒充 delivered |
| ⑥ | 请求前取消 ⇒ 保持 `pending` |

### 仍未完成

| 必做项 | 现状 |
|---|---|
| 模型迭代多次时"各自独立记录" | 部分：回执按请求一份，但多迭代的请求标识尚未分别落账 |
| `failed-before-dispatch` 的 receipt 语义（保持 pending） | 已按卡实现，但未单独断言回执不写 |
| 请求装配固定"实际携带消息 ID 集合 + 载荷指纹" | 未做：目前只带消息 ID 集合 |
| 适配器层"回执写失败启动补写" | 未做 |

### 门禁

**820 files / 5408 passed + 3 skipped，exit 0**。

## 14. 施工记录：WIRING-04-04（方案 C）第一步（2026-11-17）

### 解析链（按卡内指定方案 C）

```text
mission task ──精确映射(missionTaskSequenceMapStore)──▶ 序列节点(agentTaskSequenceStore)
            ──▶ contextPack + 序列 revision + 内容哈希
```

| 项 | 位置 |
|---|---|
| 解析模块（三态 + 哈希 + 禁止 0 占位） | `orchestration/context-pack-resolution.ts` |
| 提供者钩子 `contextPackResolver` + 预算阻塞 | `orchestration/context-prompt-assembler.ts` |
| 运行时用真实存储实现解析（missionRelationIndexStore → mapStore → sequenceStore） | `application/application-runtime.ts` |
| 新错误码 `context-pack-unresolvable` / `context-pack-budget-exceeded` | `core/errors.ts` |

### 反例

| 用例 | 断言 |
|---|---|
| `context-pack-resolution` ①-⑥ | 精确映射命中返回包+revision+哈希；缺映射 `mapping-missing`；节点读不到 `declared-but-missing`；未声明 `no-pack-declared`；revision=0 阻塞；哈希稳定/变化 |
| `context-prompt-assembler` 新增 3 条 | 有包 ⇒ 提示词含成员摘要；声明却读不到 ⇒ 抛 `context-pack-unresolvable`；未声明 ⇒ 照常装配 |

### 过渡状态（实测发现，必须记录）

首次接线后 `task-briefing-product-path` 直接红：真实 mission **没有** mission↔序列映射，
按"缺映射即阻塞"会让**所有任务无法启动**。

处理：`isContextPackMappingRequired`（缺省 false）——缺映射暂按无包运行并记录该配置项；
`declared-but-missing`（声明了包却读不到）**始终阻塞**。映射写入后应打开该开关。

### 仍未完成

| 项 | 现状 |
|---|---|
| 生产链路写入 mission↔序列映射 | 未做（映射写入方不属于本卡范围）→ 阻塞开关只能保持关闭 |
| 显式依赖引用（dependencyReferences） | 未接：解析层已有端口，装配仍传空数组 |
| 包的内容哈希与 revision 落账到运行记录 | 未做 |

### 门禁

**821 files / 5417 passed + 3 skipped，exit 0**。

## 15. 施工记录：WIRING-04-02 第二步（2026-11-17）

### 载荷指纹落账

| 项 | 内容 |
|---|---|
| Worker 在请求前计算指纹 | `sha256(systemPrompt + "\n\n" + 任务正文)`（`orchestration/worker-agent.ts`） |
| 投递端口转发 | `markDelivered({ …, payloadFingerprint })`（`orchestration/coordination-context-delivery.ts`） |
| 准入回执持久化 | `ContextInjectionReceipt.payloadFingerprint`（`orchestration/context-admission.ts`） |
| 断言 | `coord01-context-delivery-wiring` ② 校验回执里是 64 位十六进制 |

语义：指纹只证明"这次请求带上了这份内容"，**不证明模型理解**，也不等于业务成功。

### 过程记录（一个反复出现的失误）

本轮又一次"以为改上了"：端口**接口**加了 `payloadFingerprint`，但 `markDelivered` 的**实现**没转发，
导致回执里恒为 undefined。靠打印 `receipt.payloadFingerprint` 才定位。
这类 `.Replace` 静默不匹配已连续出现三次，后续每处改动都要 grep 验证插入点。

### 仍未完成

| 必做项 | 现状 |
|---|---|
| 多次模型迭代**各自独立**落账 | 未做：目前一次 worker 运行只落一份最终回执 |
| 回执写失败后启动补写 | 未做 |
| mission↔序列**精确**映射写入方 | **阻塞**：写入方只写 `missionTaskIdentifier: "*"`（`main-controller.ts:2417`），
  严格映射模式无法启用 |

### 门禁

**821 files / 5417 passed + 3 skipped，exit 0**。

## 16. 施工记录：WIRING-04-02 第三步（2026-11-17）

### 投递顺序修正 + 启动补写

| 项 | 内容 |
|---|---|
| 顺序 | `markDelivered` 改为**先写入准回执、再更新邮箱投影** |
| 理由 | 反序会产生"邮箱说 delivered、回执却没有"的**不可恢复**状态（本轮实测踩到：回执写失败被吞） |
| 补写 | 新增 `reconcileContextDeliveryProjection`：按回执补写邮箱状态；**无回执证据的消息不补** |
| 接线 | `runStartupRecovery` 在旧状态迁移之前执行（失败不阻塞启动） |

### 反例

`tests/core/integration/wiring04-delivery-projection.test.ts`：

- ① 投影写抛错 ⇒ 回执已落（含 `payloadFingerprint`）、邮箱仍未投递；启动补写后邮箱变 delivered；
- ② 无回执证据 ⇒ **不**补写成 delivered（保持未投递）。

### 仍未完成

| 必做项 | 现状 |
|---|---|
| 多次模型迭代**各自独立**落账 | 未做（一次运行仍只落一份最终回执） |
| mission↔序列精确映射写入方 | **阻塞**（只写 `*` 通配） |
| 01 的 revision/执行尝试核验 | **阻塞**（消息无字段） |
| 01 的原子提交单元 | 需设计 |

### 门禁

**822 files / 5419 passed + 3 skipped，exit 0**。

## 17. 施工记录：WIRING-04-02 收口（2026-11-17）

### 多迭代分别落账

| 项 | 内容 |
|---|---|
| 事件带迭代序号 | `RequestLifecycleEvent.iterationIndex`，由工具循环盖章 |
| 回执按迭代留痕 | `ContextInjectionReceipt.deliveryAttempts[]`（requestIdentifier / 指纹 / iterationIndex / 时间） |
| 幂等 | 同一 `requestIdentifier` 重复记录不追加 |
| 首次投递时间 | 后续迭代**不覆盖** `deliveredAtIso`（它表示"第一次真正带上"） |
| 请求标识来源 | 改用**适配器**给出的 `requestIdentifier`；worker 自造的 `worker-turn:*` 已移除（它不是请求证据） |

反例 `tests/core/unit/context-delivery-attempts.test.ts`（2 条）：两次迭代 ⇒ 两条 attempt 且首次时间不变；同请求重复 ⇒ 幂等。

### WIRING-04-02 完成度（如实）

| 卡内要求 | 状态 |
|---|---|
| 只按适配器生命周期落回执 | ✅ |
| prepared/failed-before-dispatch 保持 pending | ✅ |
| acknowledged ⇒ delivered；outcome-unknown ⇒ unknown | ✅ |
| 一次请求一份回执（移除逐事件重复写） | ✅ |
| 固定携带消息 ID 集合 + 载荷指纹 | ✅（指纹为整块内容哈希） |
| **多迭代各自独立记录** | ✅ |
| 回执写失败启动补写 | ✅（投影方向） |

### 门禁

**823 files / 5421 passed + 3 skipped，exit 0**。

## 18. 施工记录：WIRING-04-05 第一步（2026-11-17）

### 已接：显式回访内容进入装配

`createContextPromptProvider` 新增 `recalledContextBlocksProvider`：返回带
`contextNodeIdentifier + sourceRevision + text` 的块，交由 `assembleContextPrompt` 注入；
缺省不注入（旧行为不变）。

反例 `context-prompt-assembler` 新增 2 条：提供的块进入提示词；未提供不注入。

### 阻塞：**没有回访工具**

核实结论：`ContextRecallController.recall()` 与 `MainController.recallClosedContext()` 都已存在
（含 schema 绑定节点/revision/原因码/预算、按 taskExecution 限次、拒绝路径），
但**工具注册表里没有任何回访工具**：

```text
grep "recall" packages/core/src/tools → 只有 help/documentation 相关，无工具描述符
BUILTIN_TOOL_DESCRIPTORS 中无 recall 条目
```

即"运行中的临时历史需求通过工具请求"这一步**没有入口**，模型无法发起回访。

新增该工具需要先定：权限类别（readonly？）、是否受限、审计与限次策略如何与
`ContextRecallController` 的预算叠加——这些属于权限设计决策，不是消费端能自行拍板的。

### 门禁

**823 files / 5423 passed + 3 skipped，exit 0**（`graph-change-deterministic-drill` 抖动一次，隔离重跑通过）。

## 19. 施工记录：WIRING-04-03 第一步（2026-11-17）

### 缺口（审计发现）

`MissionOrchestrator.completeTaskByTaskIdentifier(taskId, outcome)` 是**公开入口**，
任何调用方都能直接标 `done`，绕过 `evaluateAuthoritativeCompletion`。
卡内明确要求："内部完成 API 改为接收受控校验结果或在内部校验，防止新增调用方绕过。"

### 实现

| 层 | 改动 |
|---|---|
| `mission-orchestrator` | `completeTaskByTaskIdentifier(..., completionAuthorization?)`：`done` 缺凭证 ⇒ 抛 `completion-not-authorized`；`failed` 不需凭证 |
| `main-controller.applyCoordinationTaskOutcome` | 转发 `completionAuthorization`（不吞、不造） |
| `application-runtime` | 只有**通过权威门禁**后、且 `coordinationTaskStatus === "done"` 时才发放 `authoritative-completion-accepted` 凭证 |

### 守卫

`tests/architecture/wiring04-completion-authorization-guard.test.ts`（3 条）：
入口自校验、控制器转发、运行时仅在 done 时发放。

### 仍未完成

| 项 | 现状 |
|---|---|
| 非活动 mission 持久状态入口的**行为**反例 | 未补（本次只有静态守卫） |
| 01 的 revision/执行尝试核验 | 阻塞（消息无字段） |
| 01 原子提交单元 | 待设计 |

### 门禁

**824 files / 5426 passed + 3 skipped，exit 0**。

## 20. 施工记录：WIRING-04-03 第二步（2026-11-17）

### 非活动 mission 入口同样要凭证

审计发现第二条绕过路径：`applyCoordinationMessageToTaskState`（写任务链的持久状态入口）
也是导出函数，任何调用方都能直接写 `done`。

| 层 | 改动 |
|---|---|
| `coordination-task-state.ts` | `done` 缺 `completionAuthorization` ⇒ 抛 `completion-not-authorized`；`failed` 不需凭证 |
| `application-runtime.ts` | 非活动 mission 分支在门禁通过且 `done` 时传凭证 |
| 守卫 | `wiring04-completion-authorization-guard` 增加 ①b（写链入口自校验） |

### 行为反例

`tests/core/integration/coord01-task-state-application.test.ts` 新增 2 条：

- ① 无凭证的 `done` ⇒ 抛错且 `updateTaskChain` **未被调用**（任务链不被污染）；
- ② 带凭证 `done` ⇒ applied；`failed` 无凭证 ⇒ applied。

既有 4 条断言保留原意，仅补上凭证参数（验证的是写链语义，不是授权语义）。

### 全量门禁回归（如实记录）

第一次全量出现 7 个失败：4 个是崩溃/竞态用例**直接调用写链函数**（缺凭证，已按新契约补参数），
另外 3 个（`anthropic-tool-loop-failclosed`、`g3a-positive-path`）**隔离重跑全部通过** ⇒ 负载抖动。

### 门禁

**824 files / 5429 passed + 3 skipped，exit 0**。

## 21. 施工记录：WIRING-04-05 第二步（2026-11-17）

### 回访工具已落地（解除"没有入口"的阻塞）

| 组成 | 位置 |
|---|---|
| 工具描述符 `recallClosedContext`（readonly / mutation none / standard 授权） | `tools/builtins.ts` |
| 权限映射（复用 `project.read`） | `tools/permission-capability-catalog.ts` |
| 范围门禁分类（本地只读、不触达项目文件路径） | `tools/scope-authorization-gate.ts` |
| 调用适配层（身份由 harness 注入；模型自带身份即拒绝） | `orchestration/recall-tool-call.ts` |
| 运行时处理器（调 `ContextRecallController.recall`，只读结果进工具响应） | `application/application-runtime.ts` |

### 反例

`tests/core/unit/recall-tool-call.test.ts`（5 条）：身份透传、模型自带身份被拒、非法 JSON 明确拒绝、
空身份拒绝、控制器拒绝原样返回（不包装成成功）。

### 卡内要求逐条对照

| 要求 | 状态 |
|---|---|
| 运行中临时历史需求经工具请求 | ✅ 工具已注册 |
| 调用者身份由 harness 注入 | ✅（模型参数同名字段被拒） |
| 绑定节点 + 固定 revision + 原因码 + 预算 | ✅（schema 强制，控制器再校验） |
| 结果进工具响应，不两处重复注入 | ✅ 只进工具响应（未同时写 `recalledContextBlocks`） |
| 不重开节点 / 不恢复任务 / 不改档案 | ✅ 只读 + `sideEffectStatus: "none"` |

### 仍未完成

| 项 | 现状 |
|---|---|
| 候选索引（显式引用/依赖/产物关联）供模型发现可回访节点 | 未做（策略层已有 `buildClosedNodeRecallCandidateIndex`，未接数据源） |
| 04 精确映射写入方 | 阻塞（只写 `*` 通配） |
| 01 revision/执行尝试核验 | 阻塞（消息无字段） |
| 01 原子提交单元 | 待设计 |

### 门禁

**825 files / 5434 passed + 3 skipped，exit 0**。

## 22. 施工记录：WIRING-04-05 第三步（2026-11-17）

### 最小候选索引（找不到节点时才给）

| 项 | 内容 |
|---|---|
| 数据源 | `contextClosureCapsuleStore.listCapsules(callerAgentInstanceId)` —— **只列该调用者自己的**已关闭胶囊（个体隔离） |
| 返回内容 | 只有 `contextNodeIdentifier + sourceRevision`，**不含正文**；最多 5 条 |
| 触发条件 | 控制器返回 `not-found` 时随拒绝一起返回；成功回访**不附**候选 |
| 提示 | 明确写"正文需再次请求并说明原因码"，避免模型把候选当正文 |

反例 `recall-tool-call.test.ts` 新增 2 条：找不到 ⇒ 5 条候选且无 `text` 字段；成功 ⇒ 不含 `candidates`。

### 卡内要求对照（05）

| 要求 | 状态 |
|---|---|
| 默认显式按需回访 | ✅ 工具只在被调用时读 |
| 不自动相似度召回正文 | ✅ 无任何自动召回路径 |
| 预声明依赖可读指定内容 | ✅ 由请求参数 + 控制器校验 |
| 候选仅基于显式/依赖/产物关联 | ⚠️ 当前候选来自**该个体的已关闭胶囊**（等价于"显式可访问集合"），依赖/产物关联尚未单独并入 |
| 回访不改状态 | ✅ 只读 |

### 门禁

**825 files / 5436 passed + 3 skipped，exit 0**。

## 23. 施工记录：WIRING-04-01 第五步（2026-11-17）

### 应用证据与状态变更进入同一次原子提交

卡内要求："同消息幂等证据与任务状态变更必须处于同一个原子提交单元。"

| 项 | 内容 |
|---|---|
| 任务链文档新增 | `coordinationApplicationEvidence[]`（messageIdentifier / appliedAtIso / resultingTaskStatus） |
| 写链逻辑 | 判重放入 `updateTaskChain` 的 **updater 内部**（先读后写的竞态被消除）；证据与状态在同一次整文档写入中落盘 |
| 重放语义 | 同消息重放 ⇒ `status-unchanged`，**revision 不再递增**、证据不重复 |
| 无变化快路径 | 状态已等于目标 ⇒ 直接返回，不调用 `updateTaskChain`（避免无意义写盘） |

### 反例

`coord01-task-state-application.test.ts` 新增 2 条：

- ⑤ 同一消息两次 ⇒ revision 只涨一次（4），证据仅 1 条；
- ⑥ 不同消息在"状态已达成"后再来 ⇒ 不重复记证据（状态不变不产生第二次迁移）。

### 边界（如实）

- 跨**两个存储**（意图台账 vs 任务链）的原子性仍未解决：台账是独立文件。
  当前靠"意图先写 → 应用 → 对账"处理；合并两者需要统一存储层，属更大改造。
- 其它重写任务链的代码路径若从零构造文档，可能丢弃该证据字段 ⇒ 退化为"按状态判重"（不产生错误，只是少一层证据）。

### 门禁

**825 files / 5438 passed + 3 skipped，exit 0**。

## 24. 施工记录：WIRING-04-04 第二步（2026-11-17）

### 区分"关联不精确"与"未声明包"

投影侧目前只写 `missionTaskIdentifier: "*"`（整 mission 级）。读取侧此前把"没有精确项"一律
当作 `mapping-missing`，而过渡期又不阻塞 ⇒ **真实的"关联存在但不精确"被静默吞掉**。

| 项 | 内容 |
|---|---|
| 新结果种类 | `mapping-imprecise`（存在 `*` 关联但无精确项） |
| 严格模式（`isContextPackMappingRequired=true`） | 阻塞，原因写明"只有整 mission 级关联（*），无法确定该任务的包" |
| 过渡期（缺省关闭） | 不阻塞、不注入包（与之前行为一致，但**不再被误报为"未声明"**） |
| 绝不 | 按名称 / 最近任务 / 固定 `T-001` 猜精确映射 |

### 反例

`context-prompt-assembler.test.ts` 新增 2 条：④ 严格模式抛 `context-pack-unresolvable`；
⑤ 过渡期照常装配、不注入。

### 仍未完成

| 项 | 现状 |
|---|---|
| 精确映射**写入方** | 阻塞：投影侧仍只写 `*`（需改发布侧，不在本卡范围） |
| 包 revision 落账到运行记录 | 未做 |
| 显式依赖引用（dependencyReferences） | 未接（解析层已有端口，装配仍传空） |

### 门禁

**825 files / 5440 passed + 3 skipped，exit 0**（`nodectx01-multi-model-fake-service-e2e` 抖动一次，隔离重跑通过）。

## 25. 施工记录：WIRING-04-04 方案 A 第一步（2026-11-18，用户裁决）

### 背景

用户裁决选择**方案 A**：给 mission 任务节点加来源字段，由投影侧建立**精确映射**，
取代"只写 `missionTaskIdentifier: "*"`"的通配关联。

### 已实现

| 项 | 内容 |
|---|---|
| 任务节点新字段 | `sourceSequenceTaskIdentifier` / `sourceSequenceIdentifier` / `sourceSequenceOwnerAgentInstanceIdentifier`（均可选） |
| 精确绑定规则 | `bindExactMissionTaskMapping`：三者齐全才写；缺一返回 `skipped-missing-source`；**拒绝通配** |
| 接线 | `MainController.injectMissionTask` 成功注入且来源齐全 ⇒ 建立精确映射（失败不阻断注入） |
| 缺来源时 | **不写通配兜底**（不把"不知道"伪装成"整 mission 级关联"） |

### 反例

`tests/core/unit/mission-task-exact-mapping.test.ts`（4 条）：

- ① 来源齐全 ⇒ 精确映射（且**不存在** `*` 条目）；
- ② 缺一个来源 ⇒ 不写；
- ③ 用通配任务标识 ⇒ 拒绝；
- ④ 两个 mission 任务各绑自己的序列节点（同名任务不串包）。

### 已知边界

- `injectMissionTask` 里绑定是**fire-and-forget**：注入后立刻跑该任务时，严格模式可能瞬时读到"未精确映射"。
  若要消除，需要改为注入前同步绑定或读侧短暂重试——本轮未做。
- 真正把来源字段**填进** mission 节点的写入方（规划/投影）仍不在本卡：本轮提供的是字段与绑定规则；
  没有该字段的任务按"来源不可考"处理，严格模式会阻塞（符合卡内要求）。

### 门禁

**826 files / 5444 passed + 3 skipped，exit 0**。

## 26. 施工记录：版本与执行尝试核验（2026-11-18，用户裁决同意）

### 改动

| 层 | 内容 |
|---|---|
| 消息 | `FeedbackMessage` 新增可选 `taskRevision` / `executionAttempt`（生产者填写） |
| 门禁 | `evaluateAuthoritativeCompletion` 新增四项输入；**双方都有值**才比较 |
| 拒绝码 | `task-version-mismatch` / `execution-attempt-mismatch` |
| 运行时 | 传入消息声明值与任务链当前 `revision`；执行尝试当前无权威来源 ⇒ 传 `null`（如实不可验证） |

### 语义（必须记住）

- 消息**没声明**版本/尝试 ⇒ 视为不可验证，**既不拒绝也不默认通过**（否则旧生产者全停）；
- 消息声明了、权威侧也有值且不一致 ⇒ **拒绝**（旧版本/旧尝试不得结算）。

### 反例

`coordination-completion-gate.test.ts` 新增 3 条：⑯ 旧版本拒绝；⑰ 旧尝试拒绝；⑱ 一致或缺失 ⇒ 接受。

### 已知限制（重要）

当前"权威当前版本"取的是**任务链文档 revision**，不是**单任务版本**——任何一次链写入都会抬高它。
后果：并发场景下，一条合法完成反馈可能因为期间别的任务写入而被判 `task-version-mismatch`。
要收紧需要"按任务的 revision"或"执行尝试登记"，两者当前都不存在；本轮不靠猜补齐，如实记录。

### 门禁

**826 files / 5447 passed + 3 skipped，exit 0**。

## 27. 施工记录：(3) 台账合并前先做的强杀证明（2026-11-18）

用户已同意"把意图并入任务链文档"。动手改布局前，先按卡内纪律写**两写之间强杀**的反例，
结论改变了实现计划：

| 场景 | 结果 |
|---|---|
| 意图已写（pending）→ 结构更新已提交（done + 证据）→ 终止 | 恢复以**链上证据**判定 ⇒ 只补 `completed`，`revision` 不再增长（无重复迁移） |
| 意图已写 → **未**发生结构更新 → 终止 | 恢复补做一次，`revision` 3→4，证据仅 1 条（不漏更新、不重复） |

证据：`tests/core/integration/wiring04-intent-merge-recovery.test.ts`（2 条，均通过）。

### 结论（与最初计划不同，如实记录）

链路径的**正确性窗口已经闭合**：证据与状态在同一次链写入中落盘（§23），
恢复又以该证据为准（§17）。因此"把意图并入链文档"**不会修复已知缺陷**，
只会消除一个中间状态（pending 意图），代价是改持久化布局 + 迁移旧台账。

### 待用户裁决

1. **就此处收口**：把"两条写 + 对账"作为设计结论写入文档（当前行为已可证明正确）；
2. **仍要合并**：按原计划改布局（意图进链文档），我按"先反例后实现 + 旧数据迁移"推进。

### 门禁

**827 files / 5449 passed + 3 skipped，exit 0**。

## 28. 裁决：(3) 就此收口（2026-11-18）

用户裁决：**不合并**台账进任务链文档，接受"两条写 + 以证据对账"作为设计结论。

### 设计结论（当前有效）

```text
意图台账（coordination/task-application-ledger.json）
  作用：崩溃后**知道有活儿没干完**（待办清单），不是第二份任务真相
  写入：应用之前（consumer 内）
  完成：权威提交后补写 completed

任务链文档（task-chain.json）
  作用：唯一任务真相 + 消息应用证据（coordinationApplicationEvidence，与状态同一次原子写）
  恢复：以链上证据判定是否已应用；有证据只补回执，无证据才补做
```

为什么这样能保证正确（对应 §27 的两条强杀反例）：

- 崩溃在"结构更新前"：意图在、证据无 ⇒ 补做一次；
- 崩溃在"更新后、回执前"：证据在 ⇒ 只补回执，不重放。

### 因此不做的事

- 不改持久化布局、不迁移旧台账；
- 不把意图当权威（权威只有任务链/调度器）；
- 不为"消除中间状态"承担迁移风险。

### 后续

(1) 精确映射的来源字段填充仍是下一步：字段与绑定规则已就绪（§25），
缺口是"谁在分解/投影时填写来源"。需要先追踪 mission 创建与分解写链路径再动手。

## 29. 施工记录：WIRING-04-04 方案 A 第二步（2026-11-18）

### 来源字段开始被真正填写

| 位置 | 内容 |
|---|---|
| mission 创建（`main-controller`） | **单节点 + 有用户任务序列** ⇒ 节点带上三个来源字段，并建立精确映射 |
| 多节点分解 | **不填、不绑**（1:N 无法确定来源；不猜） |

### 顺带发现并修掉一个会静默丢数据的缺陷

`taskChainSchema`（zod）**没有登记** `coordinationApplicationEvidence` 与新增的来源字段。
zod 默认**丢弃未知字段** ⇒ 经过 schema 的读写会把手写进去的证据**悄悄删掉**，
而用假 store 的单测仍然全绿。

已登记两个字段，并加回归守卫 `task-chain-schema-preserves-wiring-fields.test.ts`（3 条）：
证据保留、来源保留、非法状态值被拒。

### 又一次真实回归（必须记录）

首次全量：**46 files / 68 tests 红**，整条产品链路 `blocked`。
根因：精确映射的属主写成了 `responsibleSecondaryAgentInstanceId`，
而序列注册用的是 `resolveSecondaryAgentInstanceIdentifier(missionId)` —— 属主不一致 ⇒
解析层读不到序列节点 ⇒ `declared-but-missing` ⇒ 任务被阻塞。

修法：注册与绑定用**同一个**属主变量。修复后全量恢复绿。

### 门禁

**828 files / 5452 passed + 3 skipped，exit 0**。

## 30. 施工记录：按节点严格度（2026-11-18）

### 问题

全局 `isContextPackMappingRequired` 只能"全开/全关"：开了会让**多节点/旧任务**全部阻塞，
关了又让**已声明来源**的节点继续宽松运行。

### 做法：严格度由**节点是否声明来源**决定

| 节点情况 | 判定 |
|---|---|
| 声明了来源（三字段齐全）且映射一致 | `exact` ⇒ 用该序列节点 |
| 声明了来源但映射缺失/不符 | `declared-missing` ⇒ **阻塞**（必要输入不可得） |
| 未声明来源、只有 `*` | `imprecise` ⇒ 过渡态（不阻塞、不注入） |
| 未声明来源、无任何关联 | `missing` ⇒ 过渡态 |

实现：纯函数 `classifyContextPackMapping`（可单测）+ 运行时解析器接入；全局开关保持不变。

### 同时修掉的竞态

原先精确绑定是 **fire-and-forget**；一旦严格度按节点生效，首个 worker 可能抢在绑定前启动 ⇒
被误判 `declared-but-missing` 而阻塞。改为**创建时同步 await 绑定**（失败不阻断创建）。

### 反例

`context-pack-resolution.test.ts` 新增 3 条：⑦ 一致 ⇒ exact；⑧ 缺失/不符 ⇒ declared-missing；
⑨ 未声明 ⇒ imprecise / missing。

### 门禁

**828 files / 5455 passed + 3 skipped，exit 0**。

## 31. 施工记录：WIRING-04-04 方案 A 第三步（2026-11-18）

### 多节点也能声明来源

| 项 | 内容 |
|---|---|
| 分解契约 | 候选稿节点可带 `sourceSequenceTaskIdentifier`（**只允许声明用户任务 id**，序列/属主属权威信息） |
| 采信规则 | `stampDeclaredSequenceSources`：声明 === 权威用户任务 ⇒ 补齐三元组；不一致或上下文缺失 ⇒ **剥离并上报**（不采信） |
| 单节点隐式 | 单节点分解本身就是那条用户任务（1:1）⇒ 未声明也补齐 |
| 绑定 | 每个已补齐来源的节点都建立精确映射（**同步 await**） |

### 反例

`task-sequence-source-stamping.test.ts`（4 条）：一致 ⇒ 补齐并可绑定；不一致 ⇒ 剥离并报告；
缺权威上下文 ⇒ 一律剥离；未声明 ⇒ 保持原样（不强行补）。

### 说明

候选稿声明是**可选**的：模型不声明时，多节点任务仍走过渡态（不阻塞、不注入）。
这样"能严格的地方严格，不能确定的地方不假装"。

### 门禁

**829 files / 5459 passed + 3 skipped，exit 0**（`context-runtime-wiring` 抖动一次，隔离重跑通过）。

## 32. 施工记录：简报显示任务来源（2026-11-18）

### 改动

| 层 | 内容 |
|---|---|
| `buildTaskBriefing` | 新增一行 `- 来源任务：<id>（用户任务序列中的原始任务）`；未声明时写「未声明」 |
| Worker | 把任务节点的 `sourceSequenceTaskIdentifier` 传给简报 |

### 为什么值得做

模型现在能知道"我这一步源自哪条用户任务"，而不是只看到任务正文。
这直接支撑卡内"资料引用不等于授权/新指令"的可读性：来源是**事实标注**，不是新指令。

### 反例

| 用例 | 断言 |
|---|---|
| `task-briefing-wiring` ⑦ | 声明来源 ⇒ 简报含 `来源任务：task-mission-1` 与"用户任务序列中的原始任务" |
| 同文件 ⑧ | 未声明 ⇒ 明写「未声明」（不伪造） |
| `task-briefing-product-path` ① | **真实请求体**里出现 `来源任务：`（产品路径证据） |

### 门禁

**829 files / 5461 passed + 3 skipped，exit 0**。

## 33. 施工记录：候选索引接入产物关联（2026-11-18）

### 不需要新增存储

卡里要求候选"仅基于显式引用 / 依赖关系 / 产物关联"。核实后发现**产物关联可以用现成数据**：

- 胶囊自带 `artifactOrCommitReferences`；
- 产物登记 `ArtifactRecordStore` 记录 `missionIdentifier` 与 `location`。

因此：**当前 mission 的产物 location** ∩ **胶囊的产物引用** ⇒ 产物关联命中。

### 实现

| 项 | 内容 |
|---|---|
| 纯函数 | `orderRecallCandidatesByArtifactAssociation`：命中产物关联的胶囊排前，其余保持原序 |
| 排序纪律 | **只重排、不扩大候选集**（仍是"该调用者自己的胶囊"）；仍然只给标识 + revision |
| 运行时 | `listCandidateReferences` 读取产物登记（仅当前 mission）+ 胶囊引用后排序 |

### 反例

`context-pack-assembly-and-recall.test.ts` 新增 2 条：

- ⑬ 命中产物的胶囊排第一，其余原序；候选仍是 `{标识, revision}`，无正文；
- ⑭ 无产物或无引用 ⇒ 保持原序（不做无关重排）。

### 仍未做

| 项 | 原因 |
|---|---|
| **依赖关系候选** | 胶囊没有任务/依赖回指字段；要做得先给胶囊记录"来源任务"，属存储改动 |
| 真实进程级（spawn）竞争/崩溃 | 需构建产物，成本较高 |

### 门禁

**829 files / 5463 passed + 3 skipped，exit 0**。

## 34. 施工记录：回访工具端到端打通（2026-11-18）——**此前三段"完成"其实不可用**

### 触发

按计划写"回访工具产品路径"反例（假 Provider 让模型真的调用 `recallClosedContext`），
第一次跑出来的是三段真实缺陷，此前单测全绿、产品路径从未被执行过：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `tool-permission-denied: 安装门禁拒绝（无可信交互通道）` | 操作分类器未登记该工具 ⇒ `unknown` ⇒ 走安装门禁 fail-closed | 分类为 `state-query`（与 `taskSequenceStatus` 同类） |
| 2 | `tool-execution-failed: 未知内置工具` | 描述符放在 `BUILTIN_TOOL_DESCRIPTORS` 里 ⇒ 被 `executeBuiltinTool` 接管，而那里没有实现 | 移出内置清单，改为**单独注册 + 自定义处理器**（与 `proposeGoal` 同模式） |
| 3 | `context-recall-invalid: schemaVersion 期望 1` | 适配层把模型参数**原样**当请求 ⇒ 缺 `schemaVersion/requestId/taskExecutionId` 等权威字段 | 适配层**由 harness 组装**请求；模型若自带这些字段 ⇒ 明确拒绝 |

### 现在的契约

- 模型只提供：`contextNodeIdentifier`、`nodeRevision`、`reasonCode`、`requiredInformation`、`maximumTokenCount`；
- harness 补充：`schemaVersion`、`requestId`（一次性）、`taskExecutionId`；
- 模型的 `callerAgentInstanceId` / 上述权威字段出现在参数里 ⇒ **直接拒绝**；
- 找不到节点 ⇒ `not-found` + 最多 5 条候选（只有标识与 revision）。

### 反例

| 文件 | 内容 |
|---|---|
| `tests/core/unit/recall-tool-call.test.ts` | 9 条：身份注入+请求组装、伪造身份、伪造权威字段、非法 JSON、空身份、缺必需字段、控制器拒绝透传、候选截断、成功不附候选 |
| `tests/core/integration/wiring04-recall-tool-product-path.test.ts` | **端到端**：假 Provider 先给分解草案、再发 `recallClosedContext` 调用；断言下一次请求里出现 `"role":"tool"`、`"tool_call_id":"tc-recall-1"`、`context-recall-refused` 与 `not-found` |

### 教训（写给后续轮次）

"工具已登记 + 单测通过"**不等于**产品路径可用。权限分类、内置执行器接管、控制器请求契约是三处独立的失配点，
只有让**真实模型请求**真的调用一次才能发现。

### 门禁

**830 files / 5466 passed + 3 skipped，exit 0**。

## 35. 施工记录：候选的依赖关系依据（2026-11-18）

### 卡内的三种依据现在都有了

| 依据 | 数据来源 | 状态 |
|---|---|---|
| 显式引用 | 调用方本身 | 原本就有（候选只来自该调用者的胶囊） |
| **依赖关系** | 胶囊新增 `sourceTaskIdentifier`（关闭该节点的任务） + 当前任务 `dependsOn` | **本轮补齐** |
| 产物关联 | 胶囊 `artifactOrCommitReferences` ∩ 当前 mission 产物 location | §33 已接 |

### 改动

| 层 | 内容 |
|---|---|
| 胶囊存储 | `CreateClosureCapsuleInput` 与 schema 新增可选 `sourceTaskIdentifier`（旧胶囊无此字段 ⇒ 不参与依赖排序） |
| 生命周期 | 关闭节点时写入 `taskIdentifier` |
| 排序 | 依赖命中 → 产物命中 → 其余（**仍只重排、不扩大候选集**） |
| 运行时 | 把当前任务的 `dependsOn` 传入排序 |

### 反例

| # | 断言 |
|---|---|
| ⑮ | 依赖任务关闭的胶囊排在产物命中之前 |
| ⑯ | 无依赖声明 ⇒ 行为与原来一致（产物优先，保持向后兼容） |

### 门禁

**830 files / 5468 passed + 3 skipped，exit 0**。

## 36. 待实施裁决：C2 单文档并发覆盖

本节回答[跨进程存储审计 §C2](../reports/WIRING04_CROSS_PROCESS_STORAGE_AUDIT.md)的范围问题，不重做 C1，不要求全仓加锁。上节通过数不是本节的验收证据。

1. 逐项展开审计的 C2 清单（含工具包子项）。在审计表中每个实际存储写一行：存储键、生产写入口、谁读取并据此做什么、覆盖策略、已有保护、测试或调用点。只读包装器标注其实际写入口，不重复加锁。
2. **默认防陈旧写入**：只要旧值覆盖新值可能丢失待办、改变身份/授权/归属、覆盖用户策略、逆转生命周期或验收结论，就按权威状态处理。按任务分文件只隔离不同任务，不能证明同一任务安全。只有能列出权威重建来源、且无执行/授权/恢复决策依赖的展示快照才可最后写入者胜；无法证明例外，一律按权威状态处理。
3. 权威可变记录在跨进程临界区内重读当前状态，校验预期版本和合法迁移，成功后原子落盘；过期提案返回显式冲突，不盲重试覆盖。不可变回执用原子首次创建：同键同内容返回原结果，同键不同内容拒绝。不重复包装已满足同等语义的存储。只锁最后一次写、只做原子替换或只用进程内互斥均不算完成。
4. **必过反例**：两个独立 OS 进程操作同一任务键；用进程消息控制 A 先读、B 提交最终裁决、A 再提交旧状态，不用睡眠赌顺序。断言 A 被拒或幂等返回已有相同结果，重开存储仍是 B 的裁决，且无重复副作用。各独立写入实现均须有冲突回归；复用公共入口的给出真实调用点。展示快照的例外须证明可重建。
5. 实施者在通过定向反例及本卡现有门禁后更新审计逐项结论、卡内记录及计划状态。审计有并行编辑时先交独立状态补丁，不覆盖他人工作。不凭本节裁决宣布已修复。

## 37. 施工结果：§36 收口（2026-11-19）

| 项 | 结果 |
|---|---|
| §36.1 C2 逐项审计 | ✅ 16 行（存储键 / 写入口 / 读者 / 覆盖策略 / 已有保护 / 测试或调用点 / 判定） |
| §36.2 默认防陈旧写入 | ✅ **12/12** 权威存储：文件锁内重读 + 预期版本（有版本的）+ 冲突显式返回 |
| §36.3 不可变回执 | ✅ 2/2（完成收据、独立裁决）：锁内重读，同键同内容幂等、异内容拒绝 |
| §36.4 两个独立 OS 进程 + IPC | ✅ 10 个存储接入 `verify:two-process-stale-write`，顺序全由进程消息驱动 |

**反例（都会红，已逐条实测）**：`goal-mode`、`recovery/attempts`、`recovery/policy`、`edit-intent-guard`、
`conversation-identity`、`goal-contract`、`goal-mission-binding`、`goal-contract-proposal`、`work-window`、
`toolkit lifecycle`、`toolkit feedback`、`cross-project-ledger`，以及收据/裁决两处不可变回执。

**未覆盖**：`tool-packages/version-state`（其快照由 controller 版本控制承载，按 §36.3"不重复包装同等语义"未再包一层）；
Linux/macOS 平台证据（本机只有 Windows）。
## 进展（2026-11-22，WIRING-04-04 反例）

`context-pack-resolution.ts` 此前零测试。本轮补 9 条反例：

- 映射分类：完整声明 + 精确映射 ⇒ `exact`；声明但缺映射 / 声明与映射不一致 ⇒ `declared-missing`（阻塞，
  不按映射猜）；未声明 + 精确项 ⇒ `exact`；只有整 mission 通配 ⇒ `imprecise`；都没有 ⇒ `missing`。
- 自愈边界：只在"完整声明且完全没有映射项"时补；已有映射（哪怕不一致）不补。
- 解析结果：缺绑定 ⇒ `mapping-missing`；映射指向读不到的节点 ⇒ `declared-but-missing`；
  节点无包 ⇒ `no-pack-declared`（合法）；revision 为 0 占位 ⇒ `declared-but-missing`；
  正常包 ⇒ 固定 revision + 稳定内容哈希。

变异承重：把 `revision <= 0` 放宽为 `< 0` ⇒ ⑧ 红。

未做：真实任务序列映射端到端（需运行时装配）；04-02/03/05 仍未开始。