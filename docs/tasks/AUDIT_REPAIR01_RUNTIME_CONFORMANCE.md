# AUDIT-REPAIR-01：执行权限、协议失败、缓存与生产接线返修

日期：2026-11-06。状态：pending。审计基线：`51949ad2`。本文件是可执行编码任务，不是已完成报告。

## 0. 执行契约与已裁定边界

- 顺序固定：01 → 02 → 03 → 04 → 05；一次只推进一个检查点，超过 3 小时记录断点再继续。不得同时改共享装配入口。
- 开工重新核对 HEAD 和工作树。本卡不授权覆盖并行修改；已有等价实现须以证据确认后复用，不重复建设。
- 只改核心、CLI、SDK、公开测试和文档；不实施界面功能。本轮不安装依赖、不调用付费模型、不发送外部消息。
- 先写失败反例，再实现，再跑对应测试。本卡要求测试，不沿用其它任务中“不测试”的豁免。
- 变量名必须可读，时间字段带单位；覆盖、删改前先备份，备份不入库。
- 必须更新本卡逐项状态及必要进度记录；共享台账不能安全修改时提交独立状态补丁。代码完成但未验证只能写 implemented-unverified。
- 每检查点独立显式路径提交，核对暂存集合后尝试推送；不得提交别人的文件。报告明确未运行、失败与环境阻塞，禁止以单测代替产品接线验收。
- 本卡不要求证明“所有设计已实现”。24 个可达性候选只是检索线索，不得批量定性为死代码，不得删除。

## 01 / P1：目标提案进入统一执行门禁

定位：`packages/core/src/application/application-runtime.ts` 的 `buildWorkerToolPort`；`packages/core/src/tools/goal-proposal-tool.ts`。

### 必须编码

1. 删除 worker 工具端口中针对 `proposeGoal` 绕过 `policyPort.execute` 的执行支路。通过现有工具注册/处理器机制注册它；所有调用均依次经过既有作用域门禁、策略包装和实际处理器，不新建第二套权限系统。
2. 保留“目标模式已激活”和“本地 mission 上下文存在”的校验，但放在受保护处理器内；激活不是授权。来源只能从本地调用上下文生成，模型参数不得覆盖主体、mission、项目或会话。
3. 该工具会持久化待确认提案，不能再声明 `readonly` / `mutationKind: none`。使用现有描述符枚举中对应持久化写入的类型及备份策略；若没有提案存储类别，新增精确的提案写能力，不映射成普通只读。禁止借机扩大文件写权限。
4. 执行前必须检查当前个体 allowedToolNames、当前 profile/revision、模式和项目作用域。未获分配、deny、ponder 均不得落盘；ask 走现有询问与裁决入口，批准必须绑定本次参数，撤销或 revision 变化后旧批准失效。
5. 只保存待确认提案，不创建契约、不自动确认、不启用目标模式。任务已取消时不写入；使用已有幂等机制防止同一 callId 重试重复落盘，不把不同调用合并成一次。
6. 主 Agent 不获得该写工具；不得为了让提案成功而放宽主 Agent 只读投影。

### 完成判据

从应用装配入口调用：allow 成功一次；deny、未分配、ponder、取消、未激活、无 mission 均无提案文件；ask 未批准无文件，批准后一个文件；参数改变或权限 revision 改变须重新裁决。加入将统一策略替换为必拒绝策略的反例，仍能保存提案则测试必须失败。证明普通工具继续走原门禁，CLI/SDK 语义不变。

## 02 / P1：Anthropic 流错误不得释放工具副作用

定位：`packages/core/src/runtime/anthropic-messages-runtime.ts`、相应 fake-server/运行时测试。

### 必须编码

1. 流解析按 SSE 事件边界组装数据，支持 CRLF、跨 chunk UTF-8、多行 data；注释/空行/ping 可忽略。非法 JSON 数据事件返回明确协议错误，不静默丢弃。
2. 显式处理 `error` 事件，生成脱敏的领域错误，不将服务端原文、密钥或请求正文放进普通日志。HTTP/网络失败保留已有处理。
3. 跟踪 message_start、工具块开始/结束、message_delta 的 stop_reason 和 message_stop。文本增量可实时显示；工具调用必须缓冲到合法终态后才发送 `toolCallRequested`。
4. 只有 message_stop 已收到、所有工具块闭合、结束原因是 tool_use、每个调用 ID/名称非空且 ID 不重复、参数为合法 JSON 对象时，才能按原顺序释放工具调用。任一校验失败则整批不释放，不允许部分执行。
5. end_turn/stop_sequence 只有在无待执行工具且 message_stop 完整时返回 success；max_tokens、未知结束原因、EOF 缺 message_stop、未闭合块和错误事件全部失败。取消返回 cancelled；超时与协议错误使用不同错误类别，不统一伪装为 provider-timeout。
6. 历史工具参数损坏不得替换成 `{}`；空参数字符串或缺失参数亦报错，合法字符串 `{}` 保留。历史消息转换不得静默丢弃需要传递的控制指导：核对 ToolLoop 生产的消息角色，把本地 system 指导合入请求顶层 system，保留顺序；不能把不可信工具正文升为 system。
7. finally 中用量观测仍至多一次，观测失败不覆盖主错误；失败不得返回 success 或伪造完成事件。不新增无限重试，不自动重放已发生副作用。

### 完成判据

fake-server 驱动真实运行时和 ToolLoop：正常文本、正常单/多工具通过；部分工具后 error、完整工具后 error、截断、非法 JSON、重复 ID、max_tokens、超时、取消均工具执行计数为 0。HTTP 错误继续可见。覆盖分块 UTF-8、CRLF、多行 SSE、历史 system 指导和参数损坏。所有测试零真实额度。

## 03 / P2：确定性磁盘缓存的安全边界和 TTL

定位：`packages/core/src/infra/cache.ts`。不是 Provider 提示缓存，也不是目标门禁状态缓存；禁止给所有 Map 统一套 TTL。

### 必须编码

1. 引入可注入时钟与 `maximumEntryAgeMilliseconds`。默认 300000 毫秒；0 表示禁用读取和写入；负数、NaN、无穷值拒绝配置。该值是本返修明确采用的保守默认值，不宣称来自旧设计。
2. 缓存项增加 schemaVersion 和 expiresAtIso。读取时检查结构、键与请求键一致、时间有效、cachedAtIso 不在未来、当前时间严格小于 expiresAtIso，且实际年龄小于当前配置上限；过期返回 stale-reject。旧格式缺少这些字段按 miss 处理，不猜测迁移。
3. 键加入 projectIdentifier、agentInstanceId、permissionProfileId、permissionRevision、工具实现版本和 schemaVersion；保留原 provider/model/input/提示词/工具子集/上下文/文件指纹。缺必填隔离字段时 bypass，禁止共享身份默认值。
4. key 只能接受规定长度的十六进制摘要，拒绝路径穿越。读入数据做运行时校验，不能只使用类型断言。
5. 指纹读取失败必须表示 unavailable 并 bypass，不能用空字符串把不同失败输入当成同一资源。缓存不保存失败、时间敏感、写操作、模型生成结果、工具调用指令或敏感内容。
6. 命中也必须先经过当前权限、作用域及敏感读取检查，不能用缓存绕过撤权。ponder 不新增缓存写入。过期条目仅逻辑失效，本卡不做磁盘删除/清理，以免引入未授权删除行为。
7. 本检查点不把 DiskCache 强行接进模型执行链。先完成可安全接入的组件；状态明确为“组件已验证，生产接线待 04 核查”。保留现有调用方兼容策略并更新测试，不以旧格式自动信任规避校验。

### 完成判据

假时钟测试到期前/恰好到期/到期后、时钟回拨、配置缩短/禁用、旧格式/损坏文件/目录穿越、不同个体/项目/profile revision 不命中。权限撤销后命中请求仍拒绝；指纹失败、敏感内容与写调用均不缓存。不得用真实 sleep 编写 TTL 测试。

## 04 / P1：生产可达性逐项分诊与两项已确认能力接线

### 必须编码与核查

1. 重跑 `scripts/audit-product-reachability.mjs`，生成独立报告。对每个候选列出：设计条款、定义、真实构造/工厂、生产调用入口、权限包装、测试、包导出、结论。分类固定为：已接入／需宿主注入／被替代／测试专用／未接入／证据不足。
2. 查调用链而非仅查类名；覆盖动态注册、别名、静态工厂和公开 SDK。脚本改为可输出结构化结果，候选数量变化不直接使构建失败。
3. `ToolDocumentationRecallController`：接入现有工具说明请求/反馈生产入口。首次完整下发、后续标准格式回访、命中返回用法、不存在向直属上级反馈；具体个体来源必须保留。不得让回访自动安装工具或扩大工具权限。
4. `AgentCommunicationDelegationController`：接入现有受认证控制面授权入口与通信路由。仅有权直属上级转交给具体同级个体；不透明句柄不得转授，不转移任务/记忆/工具权限；撤销、到期和关联 revision 变化后不可使用。复用现有授权契约，不新增默认全连接或跨项目写能力。
5. 两项若已有替代生产实现，保留唯一实现并提供实际入口证据，不再并行接入旧类；旧类标记为替代历史，不能直接删除。
6. DiskCache：本批只核查并如实标记其产品接线状态，不能宣称已带来命中收益；另列接线缺口，不在未选定确定性读操作及其敏感/权限策略前泛化缓存。其余候选只分诊并列出精确后继工作，不擅自扩大本批编码范围。

### 完成判据

两项能力均从应用或 SDK 的真实装配入口验证成功、拒绝、撤销/未知工具路径；拔掉相应装配后正向测试必须失败。报告不得把测试专用组件或宿主注入组件算作已确认产品缺陷，也不得把存在源码当成交付。

## 05：包级验收与状态纠偏

1. 依次运行 typecheck、lint、相关定向测试和 `npm run check:low-parallel`（以当前脚本存在为前提）；真实失败不得靠删断言或只报隔离重跑通过隐藏。
2. 运行现有打包与隔离消费者验证流程；只用已安装依赖和本地产物。若工具尝试联网安装，停止该步骤、记录缺少资源，不自行安装。记录 tarball SHA256、代码 SHA、命令、退出码和用例数。
3. 隔离包中通过公开入口跑目标提案权限和 Anthropic fake-server 两条闭环；不得从仓库源码绝对路径导入来冒充包验证。
4. 提交设计—实现矩阵：每项区分静态发现、反例复现、修复、产品入口、包验证。缓存明确区分组件完成和生产接线未完成；未接入候选保留后继清单。
5. 校正任务卡/台账中与本批证据冲突的完成声明，保留历史原文并添加更正，不抹掉历史失败。不能将未审查能力改为 done。

## 检查点状态

| 编号 | 当前状态 | 必须附带的交付证据 |
|---|---|---|
| 01 | pending | 应用入口权限正反例、无副作用断言 |
| 02 | pending | fake-server 错误/截断矩阵、工具执行计数 |
| 03 | pending | 假时钟、隔离和失效测试；生产接线边界 |
| 04 | pending | 逐候选分诊表、两项真实入口与拔线反例 |
| 05 | pending | 隔离包结果、哈希、状态纠偏与剩余清单 |

## 进度记录（2026-11-06）

### 01 部分交付：旁路已删除，统一门禁生效

已编码：

- `proposeGoal` 描述符改为 `restricted` / `create-only` / `not-required` / `isIdempotent: true`，
  不再声明只读或 `none`；
- 权限目录新增 `goal.propose`（devolve allow / assist ask），映射 `proposeGoal`，不再冒充 `project.read`；
- 工具注册表新增隐藏注册（`isHiddenFromPreview`）：进入执行/权限路径，但**不进主 Agent 预览**；
- `PolicyWrapper` 新增 `customToolHandlers`：无内置实现的工具在**权限/门禁全部通过后**才执行处理器；
- worker 工具端口删除 `proposeGoal` 专属旁路，改为：目标激活时把工具名加入允许集，
  统一经 `ScopeGatedToolPort → PolicyWrapper`；
- 处理器 `createGoalProposalToolHandler`：校验目标激活/mission/参数，按 `callId` 幂等落提案，
  不创建契约、不启用目标模式。

证据（已通过）：

- `goal-proposal-tool` 5/5：写描述符、专用能力映射、隐藏预览、处理器校验与 callId 幂等；
- `goal-proposal-gate` 2/2：ponder 拒绝且处理器**不被调用**；devolve 才进入处理器；
- `ar07` 命名空间守卫纳入 `goal`（有意更新）；
- 公开全量 **616 files / 4250 tests** 通过。

**未完成（不宣称检查点关闭）**：应用装配级的完整矩阵（allow 成功、deny/未分配/ponder/取消/
未激活/无 mission 均无提案文件、ask 未批准无文件/批准后一个、参数或权限 revision 变化需重裁）
尚缺端到端测试；主 Agent 预览隐藏已有注册级证据，尚无装配级断言。
- 追加（同日）：`resolveToolDescriptors` 在目标模式未激活时过滤掉 `proposeGoal`，
  避免规划器把它带进 worker 工具面（注册级隐藏之外的执行级第二道门）。

### 02 部分交付：Anthropic 流严格性

已编码：

- SSE 按**事件边界**组装（CRLF、跨 chunk UTF-8、多行 data；注释/event/id/retry 忽略）；
  非法 JSON data 事件 ⇒ `provider-protocol-error`，不再静默丢弃；
- `error` 事件 ⇒ 脱敏 `provider-protocol-error`（只保留安全事件类型，不回显原文）；
- 跟踪 `message_start` / `content_block_stop` / `message_delta.stop_reason` / `message_stop`；
- 工具调用**整批校验后才释放**：要求 stop_reason=tool_use、块已闭合、id/name 非空且唯一、
  参数为非空合法 JSON 对象；任一失败整批不释放；
- 非 end_turn/stop_sequence（含 max_tokens、未知）⇒ `provider-protocol-error`，不再伪装 timeout；
- 超时（非外部取消）单独转 `provider-timeout`；
- 历史工具参数空串/缺失/非法 JSON ⇒ `invalid-tool-arguments`（不再替换成 `{}`，合法 `{}` 保留）；
- ToolLoop 的 system 指导按原顺序合入顶层 `system`，不升格工具正文。

证据（`anthropic-messages-runtime` 24/24）：原有 17 例（夹具补全协议信封）+ 新增 7 例
（CRLF/多行、跨 chunk UTF-8、error 事件、EOF 缺 message_stop、未闭合/重复 ID/非法参数、
max_tokens、system 指导与参数损坏）。

**未完成（不宣称检查点关闭）**：

- 卡片要求的 fake-server 驱动 **ToolLoop**、断言"工具执行计数为 0"的矩阵（当前是 runtime 级事件断言）；
- 超时路径只有分类代码，尚无独立超时用例；
- 部分工具后 error / 完整工具后 error / 取消 的组合矩阵。

### 02 追加（2026-11-06，收口矩阵）

新增 `anthropic-tool-loop-failclosed.test.ts`：**fake-server + 真实 Anthropic 运行时 + 真实 ToolLoop**，
5 个用例逐一断言工具执行计数为 0：

1. 部分工具后 `error` 事件；
2. 完整工具后 `error` 事件；
3. 截断（EOF 缺 `message_stop`）；
4. `max_tokens` 与重复 ID；
5. 超时（`provider-timeout`）与取消（收敛为 `cancelled`，不再 reject）。

顺带修复：流读取期间的 AbortError 之前会冒泡为失败；现在外部取消统一收敛为
`runFinished(cancelled)`。

仍未覆盖：ToolLoop 正向"单/多工具成功执行"计数（运行时级正向用例已有）。

### 03 交付：确定性磁盘缓存安全边界（组件，未接线）

已编码（`packages/core/src/infra/cache.ts`）：

- 注入时钟 `nowMilliseconds` + `maximumEntryAgeMilliseconds`（默认 300000；0 禁用读写；
  负数/NaN/Infinity 拒绝）；
- 条目含 `schemaVersion` + `expiresAtIso`；读取校验结构、键一致、时间可解析、
  `cachedAt` 不在未来、`now < expiresAt`、实际年龄 < 当前上限；过期 ⇒ `stale-reject`；
  旧格式/损坏 ⇒ `miss`；
- 键加入 project/agent/profile/revision/toolImplementationVersion/cacheSchemaVersion；
  缺必填隔离字段 ⇒ `findBypassReason`/`cache-key-incomplete`；键只接受 64 位十六进制，
  拒绝路径穿越；
- `get(key, fingerprint|null, {authorizeRead})`：指纹不可用 ⇒ bypass；`authorizeRead=false`
  ⇒ bypass（命中不能绕过权限）；
- `shouldBypass` 新增敏感内容/工具调用指令；写/时间敏感/失败保持 bypass；
- `readFileFingerprintOrUnavailable`：读取失败返回 `unavailable`，不返回空串。

证据：`cache-safety` 11/11（TTL 到期前/恰好/之后、时钟回拨、配置缩短、TTL=0、非法配置、
键隔离 6 维、缺字段、路径穿越、旧格式/键不一致/schema 拒绝、authorizeRead、指纹不可用、
bypass 条件）；`cache-metrics` 既有 17/17 已按新 API 更新。

**边界**：本检查点**不把 DiskCache 接进模型执行链**；生产接线状态如实为"组件已验证、未接线"。

### 04 进度（2026-11-06）：分诊报告 + 结构化输出

- `scripts/audit-product-reachability.mjs` 新增 `--json` 结构化输出（候选数变化不使构建失败）；
- 生成 [`AUDIT_REPAIR01_REACHABILITY_2026-11-06.md`](../reports/AUDIT_REPAIR01_REACHABILITY_2026-11-06.md)：
  24 个候选的 生产提及/测试构造/SDK 导出/成员调用 + 初步分类；
- 明确两项**已确认零生产入口**的目标：`ToolDocumentationRecallController`、
  `AgentCommunicationDelegationController`；DiskCache 标注"组件完成、生产接线未完成"。

**未完成**：两项能力尚未真正接线；其余候选仍为初步分诊（"待核"），检查点 04 不关闭。

### 04 接线设计（2026-11-06，待实现）

**ToolDocumentationRecallController**

- 现状：模型侧已有标准请求格式提示（worker 提示词）；G4 注入只负责"首次完整用法 / 后续提醒"，
  **没有**处理模型返回的 `ASTARRAY_TOOL_HELP_REQUEST_V1`。
- 计划入口：`MainController.answerToolHelpRequest(input)`：
  - 由宿主/控制面传入 `request` + 已注入的 `requesterAgentInstanceId` / 默认上级 / mission；
  - 由 mission 任务链与注册表构造 `assignedToolIdentifiers` 与 `assignedToolDocumentation`；
  - escalationSink 走现有反馈通道发给默认上级（不新增网络/默认全连接）；
  - 公开 SDK 暴露只读响应；**不授予工具/权限/安装**。
- 反例：未分配工具不得返回 schema；缺失工具必须 escalation；陈旧 revision 必须 stale；
  同一 request 幂等。

**AgentCommunicationDelegationController**

- 现状：grant store/控制器/失效检查齐全，生产无构造。
- 计划入口：复用现有受认证控制面（权限裁决 + 通信路由）：
  - 仅直属上级可授予；目标必须恰低一级且存活；recipient 与 grantor 同级；
  - 不透明句柄不得转授；撤销/到期/revocation revision 变化后拒绝；
  - 不新增默认全连接、不转移任务/记忆/工具权限。
- 反例优先写：非直属上级、跨级 recipient、已回收 target、过期 grant、revision 变化。

**阻塞/依赖**：两项都需要接入真实控制面路由；当前公开层没有对应的命令入口，
先补 `MainController` 方法 + SDK 导出，再接 GUI/CLI（私有仓库）的界面入口。

### 04 交付（一）：工具说明回访生产入口

- `MainController.answerToolHelpRequest`：
  - 校验请求 schema；从 mission 任务链 + 注册表构造**已分配**工具公开说明；
    公开用法登记不完整/缺失 ⇒ 该工具不暴露（fail-closed）；
  - escalation 经现有 `streamOutput` 面向默认上级（不新增网络连接）；
  - 响应 `isAuthorizationGranted` 恒 false；不授予工具/权限/安装。
- 公开 SDK 新增 `requestToolHelp(input)`（只读响应）。
- 证据：`tool-help-recall-production.test.ts` 5/5：
  已分配 ⇒ usage-provided；未分配/未登记 ⇒ known-but-not-usable（不泄露 schema）；
  缺失 ⇒ escalated-missing-tool；陈旧 revision ⇒ stale-request；非法请求 ⇒ rejected；
  同 request 幂等；**拔掉登记装配 ⇒ 已分配工具退化为 known-but-not-usable**（正向依赖可证）。

**未完成**：通信转交接线；其余候选逐项核查。

### 04 交付（二）：受权通信转交生产入口

- `MainController` 构造 `DelegatedAgentCommunicationGrantStore` 与
  `AgentCommunicationDelegationController`；
- `createCommunicationDelegationGrant`：必须带 `authorizationSource` + 用户裁决引用；
  层级/存活/同级校验由控制器执行；只产生不透明句柄，不转移任务/记忆/工具权限；
- `assertCommunicationDelegationDeliverable`：撤销/回收/父子变化/mission 结束/
  profile revision/到期/消息类型/在途量逐项拒绝；
- `assertCommunicationDelegationNotReDelegable`：未知句柄拒绝（无导出/转授路径）；
- 公开 SDK：`delegateAgentCommunication` / `assertDelegatedCommunicationDeliverable`；
- 接线清单：`AgentCommunicationDelegationController` 记为 constructed。

证据：`agent-communication-delegation-production.test.ts` 4/4（合法创建+投递通过；
层级/存活/缺裁决拒绝；撤销/回收/父子/mission/revision/类型/在途/非 recipient 拒绝；
未知句柄与过期拒绝）。

### 04 收口（2026-11-06）

两项能力均已接线并有反例；24 个候选完成最终分诊（报告 §6），分类使用固定六类，
"被替代/未接入"标注后继核查边界，不宣称已删除或已验收。
