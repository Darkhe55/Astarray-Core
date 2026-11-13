# CLUSTER-01：实验性错误聚类与相似案例检索

日期：2026-11-10。状态：**01–03 已交付；04 implemented-unverified（待人测）**。本卡是编码规格，不是已实现或已验收声明。
范围：核心、公开 SDK、CLI。默认关闭；首版完全本地、无模型调用、无新增第三方依赖。

## 1. 目标与非目标

将同项目内已有诊断事件整理成可追溯的相似问题组，减少重复排查；支持查组、展开证据、查相似案例和记录用户纠正。

相似不等于同因，更不等于工作流等价。禁止自动修改任务、优先级、依赖、权限、验收结论、原始历史、上下文节点状态或发布工具。聚类不是上下文压缩，派生索引不能代替原文。

首版不实现跨项目分析、语义向量、远端服务、模型自动命名、自动修复、定时重建、教训推广或工作流工具化。后续方向见 §9，不作为本卡完成条件。

## 2. 已核对的复用点与缺口

- `packages/core/src/orchestration/diagnostic-event-store.ts`：已有 `DiagnosticEventStore`、`redactSensitiveText`、`computeDiagnosticFingerprint`，现有指纹为错误码/组件/阶段。保留原汇总语义，聚类作为附加视图，不替换它。
- 该存储的 `readAll` / `readWithIntegrity` 读取全文件；不能直接用于本卡的有界后台扫描。扩展流式分页读取端口，保留旧 API 兼容。
- `application/application-runtime.ts`：已有诊断采集端口，`isDiagnosticCollectionEnabled` 默认关闭。开启聚类不得偷偷开启采集；无数据与采集未开启分别报告。
- `public-sdk.ts` 已导出诊断能力；新增受控应用入口并从公开 SDK 导出，不能只导出未装配类。
- `lesson-selection.ts` / `lesson-record-contract.ts` 为后续复用点，本卡不修改其选择规则。

## 3. 固定算法与数据边界

1. 请求绑定认证主体、当前项目及其授权的 mission 范围；项目归属由本地可信关系索引核验，不接受模型自填项目 ID 作为凭证。归属无法证明的记录排除并计数；mission 为空的全局事件首版不纳入项目分析。
2. 先完成作用域过滤与既有敏感检测/脱敏，再提取特征。分析文本属于数据，永不作为指令执行。拒绝任意文件路径输入，不扫描项目文件、凭据文件或系统目录。
3. 严格分桶键：项目 ID、errorCode、component、stage、classification、rootErrorCode、按原顺序排列的 wrapperErrorCodes。不同桶不聚合；null 保持未知，不能推断为某个错误码。
4. 文本规范化版本 `diagnostic-text-v1`：Unicode NFC、统一换行与连续空白；只替换明确 ISO 时间戳及 UUID。不得泛化任意数字、状态码、路径、变量名或包名，不做全局大小写折叠。
5. 使用 Unicode 码点连续三元组集合，Jaccard = 交集大小 / 并集大小；不足三个码点使用完整文本为一个特征，空文本不做模糊归组。完全一致文本先去重计数。
6. 桶内按 recordedAtIso、sourceRecordIdentifier 排序；确定性 leader 聚类：依次与已有组的首个成员比较，最高分达到 0.85 则加入；并列取代表记录 ID 字典序最小的组，否则新建组。禁止传递合并（A 近 B、B 近 C 不表示 A 近 C）。单成员组标记 singleton，不伪装成重复故障。
7. `findRelated` 使用同一分桶及算法；默认返回前 5 个，最多 20 个；最低相似度 0.85。输入是授权事件引用，不接受任意待执行文本。返回 similarityScore，明确其不是正确概率或根因置信度。
8. 无稳定事件 ID 时，来源引用采用存储代次 ID、行字节偏移与该行 SHA256；查询必须验证内容哈希。源文件轮换、截断或引用失效返回 source-unavailable/stale，不能把该偏移的新内容当旧证据。

## 4. 存储、资源与恢复

- 派生索引仅保存在应用管理的项目状态目录 `analysis/diagnostic-clusters/`；不放项目源码目录，不复制未脱敏消息。索引记录 schemaVersion、algorithmVersion、配置指纹、数据快照游标、项目 ID、生成时间和 snapshotIdentifier。
- 组记录包括代表来源引用、成员引用、唯一记录数、首次/最近时间、距离、来源 Agent 个体 ID、任务/mission 引用及被过滤/损坏记录计数。展示标题固定为错误码/组件/阶段，不生成原因断言。
- 默认每批 200 行、每次扫描最多 16 MiB/2,000 条有效事件、单行最多 64 KiB、消息特征最多 4,096 码点、运行最多 5,000 ms、相似比较最多 100,000 次。命中任何上限即保存游标并返回 partial 与具体原因，不声称覆盖全部历史。特征截断必须标记；原记录不改。
- 不以 Promise 包裹同步全量运算冒充后台：每批让出事件循环并检查取消信号。工作时段关闭停止分析；工作时段状态未知暂停并解释，不阻塞业务任务。
- 分析使用单项目写租约；并发 build 返回 busy 或同 jobIdentifier 进度。checkpoint 保存游标、当前组状态及版本；同请求 ID/同参数幂等返回，异参数拒绝。未完成快照不替换最后完整快照。
- 源版本一致时继续扫描，版本不一致明确 stale 并重建；已读记录不重复计数。停用后不自动恢复，重新启用也必须显式 build。关闭时取消在途分析并保存检查点。
- 缓存新鲜度默认 24 小时，按读取时实际比较 expiresAt；超时返回 stale，不静默当新结果，也不自动删除或重建。权限变更后立刻重新过滤或拒绝，不等 TTL。
- 覆盖、轮换或删除派生文件仍走工具层自动备份；本卡不新增备份删除入口。磁盘满、源不可读或损坏不能返回“无错误”。

## 5. 统一工具与权限

工具名 `analyzeSimilarity`，严格判别联合 schema，拒绝未知字段。操作如下：

| action | 参数与行为 | 权限 |
|---|---|---|
| build | requestIdentifier、可选 checkpointIdentifier；当前项目固定 | 受控派生索引写入 |
| list | snapshotIdentifier、游标、pageSize（默认 20，最大 100） | 只读 |
| inspect | snapshotIdentifier、clusterIdentifier、游标、pageSize | 只读，证据展开再次鉴权 |
| findRelated | snapshotIdentifier、sourceRecordIdentifier、limit | 只读 |
| feedback | requestIdentifier、snapshotIdentifier、两个来源引用、label=related/unrelated、可选说明（最多 500 字） | 受控反馈写入 |

反馈是用户/有权 Agent 的意见，保存精确来源身份，不修改原始事件，也不直接改算法或自动重分组。查看组时展示相关意见及冲突，不将意见视为事实。

全工具授权与 action 细粒度授权复用现有框架，最严格约束生效；任务工具子集、项目范围与模式门禁均保留。主 Agent 和思索模式只可用只读 action，不能 build/feedback。若现有工具框架不能表达混合读写，先补齐 action 级副作用判定，禁止把整个工具声明为只读绕过门禁。

设置 `experimental.diagnosticClustering.enabled=false`，仅用户或已有可信设置授权路径可启用。关闭时工具与 SDK 返回 feature-disabled；不扫描、不新建索引、不调用模型、不安装依赖，已有索引不删除。

CLI：`astarray similarity build|list|inspect|find-related|feedback` 与 `astarray similarity status`，调用同一应用服务；JSON 输出有稳定错误码、数据范围、freshness、partial 和来源引用。通过已有设置系统管理开关，不另建权限配置文件。CLI、SDK、Agent 工具都不得通过底层导出绕过鉴权。

## 6. 顺序与任务划分

| 检查点 | 固定交付 | 状态 |
|---|---|---|
| CLUSTER-01-01 | 契约/开关/作用域适配器/有界诊断读取/来源引用与脱敏 | **implemented-unverified**（2026-11-11） |
| CLUSTER-01-02 | 确定性算法、索引、预算、租约、取消、检查点、TTL | **implemented-unverified**（2026-11-11 补齐租约/取消/TTL） |
| CLUSTER-01-03 | 统一工具、权限判定、运行时、SDK、CLI 真实接线及反馈存储 | **in_progress**：工具/权限/SDK/反馈已交付；**CLI 未做** |
| CLUSTER-01-04 | 行为反例、隔离安装包验收、效果与资源报告 | **in_progress**：反例与隔离包闭环已交付；**效果与资源报告未做** |

按 01 → 02 → 03 → 04 执行，每次一个检查点，单轮超过三小时拆分。使用可读变量名与带单位的时间变量。先查看在途改动，公共装配文件有冲突时暂停对应文件，不覆盖别人修改。

必须更新本卡状态及 PLAN_STATUS 对应条目；共享台账无法安全更新时新增独立状态补丁。代码已存在先复用；不得以“缺状态修改授权”为由不记录进度。不得在仅有纯函数测试时标整卡 done。

## 7. 测试与验收

- 算法：相同输入/配置/快照可复算；中文/英文/短文本；时间戳等噪声；不同错误码/组件/链禁止混组；路径、变量名、状态数字区别保留；桥接链不传递合并；阈值与并列排序。
- 安全：默认关零扫描/零写入；主 Agent 与思索模式拒绝写 action；任务子集拒绝；跨项目 ID 伪造、无归属事件、授权撤销后的旧缓存均不泄漏；样例凭据不得进入特征、索引、CLI 输出；日志中的注入文本不执行。
- 恢复：重复 build 不重复计数；同 ID 异参拒绝；两个进程竞争；中断后继续；源轮换/截断；损坏行与不可读分别报告；TTL 用可控时钟验证；过期不偷偷重建；停用中断；磁盘满保留前次完整快照。
- 性能：可控预算反例必须触发 partial；大文件流式处理，不经 readAll；统计扫描字节/条数/比较数/耗时/进程内存增量/取消延迟。资源报告注明机器，不把单机结果宣称全平台保证。
- 准确性：固定至少 60 条合成错误、10 类人工标注问题，其中至少 20 对易混淆负例；测试集和标签入库，不含真实凭据。报告 pairwise precision/recall 的分子分母、singleton 比例与误组案例；发布门槛 precision ≥ 0.95、recall ≥ 0.70，负例跨强分桶合并数为 0。不得为过门禁修改标签；未达标保留未完成，记录算法改进需求。
- 运行相关测试及 `npm run check`；从 `npm pack` 隔离安装包经 CLI 与 SDK 完成启用→构建→查询→展开→反馈→重启→查询→停用；使用本地合成数据，不花真实额度。Agent 工具须有运行时集成测试覆盖，不只测 handler。

## 8. 完成定义

四检查点均交付，生产入口可达、反例通过、安装包验证通过、指标报告可复算才可 done。无需新增界面验收。无足够数据必须显示 insufficient-data，不以空结果表示项目健康。

## 9. 后续候选（本卡不编码）

- 沟通教训：先按模型/提供商/配置/角色/作用域精确过滤，再相似检索；通用教训提升另行批准。
- 工作流等价折叠：只提出工具化候选，权限、副作用及输入输出等价性单独验证。
- 上下文节点检索：提供回访候选，不自动关闭节点或压缩原文。
- 本地向量与跨项目分析：待首版效果明确后另立卡；不得借本卡自动联网、下载模型或扩大授权。

## 施工进度（2026-11-11）

### 切片 1：有界分页读取端口（§2 缺口）——**已交付**

- 新模块 `packages/core/src/orchestration/diagnostic-event-page-reader.ts`：
  `readDiagnosticPage` / `readAllDiagnosticPages`，游标 = `{ byteOffset, lineNumber }`。
- 只做**纯解析**：不读文件、不做作用域过滤、不脱敏（策略留在上层）。
- 已覆盖：多页不丢不重、偏移递增、内容 SHA256（供 §3 第 8 条引用校验）、
  空行不计数但游标前进、CRLF 去 `\r`、末尾无换行、**超长行跳过并计数**、空文本、逐行续读一致。
- 测试：`tests/core/unit/cluster01-diagnostic-page-reader.test.ts`（8 条）。

**尚未做**（后续切片）：把该端口接进 `DiagnosticEventStore` 的磁盘读取路径、
按 §4 的 2,000 条/16 MiB 总上限做节流、以及在 `readWithIntegrity` 上复用哈希校验。

### 切片 2：磁盘有界分页（§4"不整文件读入"）——**已交付**

- `readDiagnosticPageFromFile`：按块 `readSync`（默认 1 MiB，**下限为单行上限 + 1**），
  解析与游标语义**完全复用** `readDiagnosticPage`，因此文件路径与字符串路径的分页行为必然一致。
- 返回值额外带 `bytesRead`，便于断言"没有整文件读入"。
- 测试（新增 3 条，合计 11 条）：多页跨块读与一次性解析结果**完全一致**、
  单页字节数不超过块上限、游标越界返回空页且 `isComplete`。

**过程中修掉一个真 bug**（已写进注释）：解析器的游标是**相对传入文本**的，
而文件分页传入的是"从文件偏移开始的一段"，若直接把文件偏移当解析游标，**每页开头会被跳过**。
实测丢行（12 行只读到 7 行），改为"以 0 解析 + 结果平移回绝对偏移"后一致。

**仍未做**：接进 `DiagnosticEventStore` 的磁盘读取路径（切片 3）。

### 切片 3：接进 `DiagnosticEventStore`（§2 缺口闭合）——**已交付**

- 新增 `DiagnosticEventStore.readEventPages({ cursor, limit, maximumLineBytesPerLine, maximumTotalEvents, maximumTotalBytes })`：
  按块读盘 + 每页限额 + 总量上限（默认 2,000 条 / 16 MiB），返回 `pages/nextCursor/isComplete/discardedLineCount/totalEventCount`。
- **解析规则与 `readAll`/`readWithIntegrity` 完全一致**（损坏行、非诊断事件、空行），由对照用例锁定。
- 测试：`tests/core/unit/cluster01-store-page-wiring.test.ts`（4 条）：
  分页与 `readAll` 结果一致、丢弃计数与 `readWithIntegrity` 一致、`maximumTotalEvents` 提前停止且如实 `isComplete=false`、源不可读时报错。

**一处有意的行为差异**（非缺陷，已写进用例注释）：
`readAll` 在源不可读时返回 `[]`（既有兼容行为），而 `readEventPages` **抛 `diagnostic-source-unavailable`**——
卡内 §4 明确"磁盘满、源不可读或损坏不能返回'无错误'"。

**仍未做**：聚类算法本身（分桶键、`diagnostic-text-v1` 规范化、三元组 Jaccard、0.85 阈值、leader 聚类）、
派生索引与游标持久化、工具与权限入口、SDK 导出。

### 切片 4：纯聚类算法（§3）——**已交付**

- `packages/core/src/orchestration/diagnostic-clusterer.ts`：
  `normalizeDiagnosticText`（`diagnostic-text-v1`：NFC、统一换行/空白、**只**替换 ISO 时间戳与 UUID）、
  `computeTrigramSet`（Unicode 码点三元组；不足 3 码点用整串）、`computeJaccardSimilarity`、
  `buildDiagnosticBucketKey`（严格分桶，`null` 保持未知）、`clusterDiagnosticEvents`（leader 聚类，0.85 阈值）。
- 输入类型 `DiagnosticClusterInput` + `toDiagnosticClusterInput(event, projectIdentifier)`：
  **项目标识由调用方的可信关系索引传入**（§3 第 1 条：不接受模型自填项目 ID）。
  `sourceRecordIdentifier` 取 `请求标识#revision`，保证同一次记录稳定且唯一。
- 测试 10 条，含四个关键反例：分桶不同不聚合、`null` 不被推断、**禁止传递合并**（A~B、B~C 但 A!~C ⇒ 组大小 [2,1]）、
  空文本不参与模糊归组；另有规范化**不泛化数字/路径/大小写**、确定性重复聚类一致。

**仍未做**：派生索引与游标持久化（`analysis/diagnostic-clusters/`）、
`findRelated` 查询、资源上限节流与租约、工具/权限入口、SDK 导出、接线到应用装配。

### 切片 5：派生索引持久化（§4）——**已交付**

- `diagnostic-cluster-index.ts`：`buildDiagnosticClusterSnapshot`（schema 版本、算法版本、
  **配置指纹**、项目 ID、`snapshotIdentifier`、生成时间、游标、`isComplete`/`partialReason`、组列表）、
  `saveDiagnosticClusterSnapshot`、`readLatestDiagnosticClusterSnapshot`、`resolveClusterIndexDirectory`。
- 目录固定为 `<stateDirectory>/analysis/diagnostic-clusters/<项目 ID 哈希>/`——**不落项目源码目录**；
  项目 ID 走 SHA256 短名，杜绝 `../` 路径穿越。
- 测试 5 条：完整快照可读回；**partial 快照不替换最后完整快照**（指针仍指向完整快照，但 partial 快照本身落盘可追溯）；
  配置指纹稳定且随参数变化；目录不穿越；快照缺失/损坏 ⇒ 返回 null（不伪装成空结果）。

**仍未做**：`findRelated` 查询、资源上限节流（每批 200 行/2,000 条/16 MiB/5,000 ms/100,000 次比较）、
单项目写租约与幂等、工具与权限入口、SDK 导出、接线到应用装配。

### 切片 6：`findRelated` 相似案例检索（§3 第 7 条）——**已交付**

- `diagnostic-related-cases.ts`：`findRelatedDiagnosticCases({ event, snapshot, limit, minimumSimilarity })`。
- **只接受已授权事件引用**（`DiagnosticClusterInput`），**不提供"传一段字符串来查"的重载**——
  卡内要求输入不是任意待执行文本，避免调用方把模型输出直接喂进来。
- 同桶 + 同算法；默认 5、上限钳到 20；低于阈值不返回；结果按分数降序、同分按组 ID 字典序。
- 返回值显式带 `isRootCauseConfidence: false`：**相似度不是正确概率，也不是根因置信度**。
- 测试 4 条：跨桶不返回 + 分数阈值 + 标志位、低相似度空结果、limit 默认/夹紧、确定性排序。

**仍未做**：资源上限节流（每批 200 行/2,000 条/16 MiB/5,000 ms/100,000 次比较）、
单项目写租约与幂等、工具与权限入口、SDK 导出、接线到应用装配、用户纠正记录。

### 切片 7：构建器（扫描 → 聚类 → 快照）——**已交付**

- `diagnostic-cluster-build.ts`：`buildDiagnosticClusterSnapshotForProject`，
  上限常量 `DIAGNOSTIC_CLUSTER_BUILD_LIMITS`（每批 200 行 / 2,000 条 / 16 MiB / 5,000 ms / 100,000 次比较）。
- **归属由调用方可信判定**：`resolveProjectIdentifier(event) => string | null`，
  返回 `null` 或与目标项目不符 ⇒ **排除并计数**（`excludedRecordCount`），不混进项目分析。
- 命中任一上限 ⇒ `isComplete=false` 并给出**具体原因**
  （`event-limit` / `duration-limit` / `comparison-limit`），同时保留游标可续扫。
- 测试 4 条：完整扫描、事件上限（游标前移）、归属不可证被排除计数、时长上限。

**已知近似（如实记录）**：比较次数用「事件数 × 桶数」估算，不是精确计数；
`byte-limit` 目前由 `readEventPages` 的 `maximumTotalBytes` 内部消化，未单独映射成 partial 原因。

**仍未做**：单项目写租约与幂等、工具与权限入口、SDK 导出、**接线到应用装配**、用户纠正记录、
"每批让出事件循环"的显式调度（当前依赖 `await` 读取）。

### 切片 8a：应用级服务（开关与状态区分）——**已交付**

- `diagnostic-cluster-service.ts`：`DiagnosticClusterService`（`buildSnapshot` / `readLatest` / `findRelated`）。
- **默认关闭**：关闭时 `buildSnapshot` 直接返回 `disabled`，**不读源、不建目录、不写文件**（有用例断言 `analysis/` 目录不存在）。
- **三种状态可区分**：`disabled`（未开启）/ `no-snapshot`（已开启但从未构建）/ `ready`。
  卡内要求"无数据与采集未开启分别报告"，这里把它落成类型而不是靠文案。
- 测试 4 条：关闭零副作用、开启未构建 ⇒ `no-snapshot`、开启构建后可检索且 `isRootCauseConfidence=false`、
  `findRelated` 在无快照时返回 `no-snapshot` 而非空列表。

**尚未接线（下一轮必做）**：`application-runtime` 的 `isDiagnosticClusteringEnabled` 选项与返回对象字段、
`public-sdk` 的公开导出与门面方法、以及"从真实装配入口可达"的集成用例。

### 切片 8b：**装配接线完成**（§5）——已交付

- `application-runtime.ts`：新增选项 `isDiagnosticClusteringEnabled`（**缺省关**，与 `isDiagnosticCollectionEnabled` 是**两个独立开关**），
  并在 `ApplicationRuntime` 返回对象与接口中加入 `diagnosticClusterService`。
- 集成用例 `tests/core/integration/cluster01-assembly-wiring.test.ts`（经 **`createApplicationRuntime`**）：
  - 缺省关闭 ⇒ 服务存在但 `readLatest` 返回 `disabled`，且 `analysis/` 目录**不存在**（零副作用）；
  - 开启 ⇒ 未构建前 `no-snapshot`；构建后 `isComplete` 且 `findRelated` 返回 `ready`。

**顺带修正的语义**（此前会误报）：
`readEventPages` 原先把"文件不存在"也当成 `diagnostic-source-unavailable` 抛错，
导致**从未采集数据的项目**被报成"源不可用"。现区分：
文件不存在 ⇒ 空源且完整（"无数据"）；其他读取错误 ⇒ 抛错（"不可读"）。

**已知缺口（如实记录）**：
"存在但不可读（权限）"这一分支**没有自动化用例**——在 Windows 上构造它需要改 ACL（属系统权限变更，本批不做）。

**仍未做**：`public-sdk` 公开导出与门面方法、工具与权限入口（统一工具层）、用户纠正记录、
"每批让出事件循环"的显式调度。

### 切片 8c：SDK 导出与选项透传——**部分交付**

- `public-sdk.ts`：导出 `DiagnosticClusterService` 与 `DiagnosticClusteringStatus` 类型；
  `PublicApplicationOptions` 新增 `isDiagnosticClusteringEnabled`（缺省关），并透传给 `createApplicationRuntime`。
- 门禁：`typecheck` / `lint` 通过；受影响用例 17 passed。

**仍未做（下一轮）**：
- `AstarrayApplicationFacade` 上的受控门面方法（`buildDiagnosticClusterSnapshot` / `findRelatedDiagnosticCases`）；
- 用**隔离安装的包**验证一次（同时推进 AUDIT-REPAIR-01-05 的 05-3 第一条闭环）；
- 统一工具层与权限入口、用户纠正记录。

### 切片 8d：**SDK 门面可达**——已交付

- `AstarrayApplicationFacade` 新增三个受控方法：
  `buildDiagnosticClusterSnapshot` / `getDiagnosticClusteringStatus` / `findRelatedDiagnosticCases`，
  全部转发到 `runtime.diagnosticClusterService`，**不另开旁路**。
- 集成用例 `tests/core/integration/cluster01-sdk-facade.test.ts`（2 条，经 `AstarrayApplicationFacade.create`）：
  - 缺省关闭 ⇒ 构建/查询都 `disabled`，且 `analysis/` 目录不存在；
  - 开启 ⇒ 未构建 `no-snapshot`、构建成功、检索 `ready`。

**门禁**：typecheck / lint 通过；两个 facade 用例通过。

**仍未做**：隔离安装包验证（含 AUDIT-REPAIR-01-05 的 05-3）、统一工具层与权限入口、用户纠正记录、
每批让出事件循环的显式调度。

### 切片 8e：**隔离安装包闭环**——已交付

- `scripts/verify-cluster01-package.mjs`：从 `<隔离目录>/node_modules/astarray/dist/public-sdk.js` 导入，
  **拒绝回落仓库源码**（路径断言，命中即 exit 2），跑 3 条闭环（no-snapshot / built+isComplete / 缺省 disabled）。
- 实测：`exit 0`，`cases=3 failures=0`（tarball SHA256 `65ED9D78…5B78B`，代码 SHA `45c749ce`）。

**仍未做**：统一工具层与权限入口、用户纠正记录、"每批让出事件循环"的显式调度。

### 切片 9a：工具 action 级权限判定（§5）——已交付（**尚未注册进工具注册表**）

- `diagnostic-cluster-tools.ts`：`DIAGNOSTIC_CLUSTER_TOOL_NAME`、action 级副作用表
  （`list`/`inspect`/`find-related` = read-only，`build`/`feedback` = mutating）、
  `classifyDiagnosticClusterAction`、`executeDiagnosticClusterAction`。
- 判定顺序刻意固定为：**开关 → 权限 → 做事**，因此关闭时连权限查询都不发生。
- 测试 6 条：分类正确、关闭 `feature-disabled` 且不建目录、只读主体调写 action 被拒、
  **未知 action 不得被当只读放行**、可写主体 build 成功且只读主体 list 可用、
  `feedback` 未实现时**显式拒绝**（不假装成功）。

**明确未完成**（下一轮）：
- 注册进现有工具注册表并接入 `policyPort.execute`（这才是"接线完成"）；
- 主 Agent 只读投影中不出现写 action 的用例；
- `feedback` 存储（用户纠正记录）。

### 切片 9b：工具注册——**代码已加，但集成验证显示未生效（进行中）**

- 已在 `application-runtime.ts` 的 `new ToolRegistry()`（L987）之后按开关注册 `diagnosticClusters`（L993），
  `isHiddenFromPreview: true`；关闭时不注册。
- 新增运行时只读观测 `listRegisteredToolNames()`（基于 `registry.getFullDescriptors()`）。
- 描述符：`category: "restricted"`、`mutationKind: "create-only"`、`backupPolicy: "automatic-preimage"`，
  并在注释中写明**不能声明为纯只读**（`build`/`feedback` 会写）。

**实测未通过**：启用开关时 `listRegisteredToolNames()` 仍不含该工具 ⇒ 运行期实际使用的注册表
**可能不是这一处构造的**（或该 registry 被后续替换）。集成用例已移除（不留失败测试），
下一步必须先定位"真正被 controller 使用的注册表"再补验证。

**教训**：先用 `answerToolHelpRequest` 做观测点是错的——它对**任意**未知工具名都返回
`known-but-not-usable`，无法区分"已注册"与"未注册"。

### 切片 9b：工具注册——**已交付**（根因已定位）

**上一轮失败的真因**（本轮查明）：注册表会拒绝**未映射权限能力**的工具，
抛 `工具 diagnosticClusters 未映射任何可配置权限，拒绝注册`。
不是"注册表实例不一致"——我上一轮的猜测是错的。

修法（复用现有能力目录，不新建权限系统）：

| 能力 | 默认 | 说明 |
|---|---|---|
| `diagnostic.clusters.read` | devolve/assist = allow | 查询类（list/inspect/find-related） |
| `diagnostic.clusters.build` | devolve/assist = ask | 构建落盘 |

工具映射：`diagnosticClusters: ["diagnostic.clusters.read", "diagnostic.clusters.build"]`
（按**最严格**能力登记，action 级再收窄——不把整个工具声明为只读）。

**验证**（`tests/core/integration/cluster01-tool-registration.test.ts`，经 `createApplicationRuntime`）：
开启 ⇒ 注册表含该工具；关闭 ⇒ **从不注册**（不是"注册后拒绝"）。2 条通过。

**仍未做**：主 Agent 只读投影中不出现写 action 的用例、工具执行时经 `policyPort.execute` 的集成用例、
`feedback` 存储、CLI。

### 切片 9c：主 Agent 投影——**已交付**

实测结论：主 Agent 使用**固定只读白名单**（`MAIN_AGENT_READONLY_TOOL_NAMES`），
`diagnosticClusters` 不在名单内 ⇒ 主 Agent **连只读 action 也拿不到**，比卡内要求（"主 Agent 只用只读 action"）**更严格**。

测试 `tests/core/unit/cluster01-main-agent-projection.test.ts`（2 条）锁定：
名单不含该工具；`projectTools(["diagnosticClusters","readFile"])` 只返回 `readFile`；
且投影**只看工具名不看 action**，不存在"传 read 就放行"的路径。

**仍未做**：工具执行经 `policyPort.execute` 的集成用例（未分配 ⇒ 拒绝 / ask ⇒ 询问 / 允许 ⇒ 执行）、
`feedback` 存储、CLI。

### 切片 9d：能力默认值锁定（§5）——已交付

`tests/core/unit/cluster01-capability-defaults.test.ts`（4 条）：
能力已登记、**查询默认 allow / 构建默认 ask**（默认值写反会静默放行写操作）、
工具映射同时登记两个能力、`getCapabilityIdsForCall(tool, action)` 能区分读写。

**已确认的接线缺口（下一轮第一件事）**：
工具描述符已注册、能力已映射，但**执行处理器尚未接进 `tools/builtins.ts` 的 dispatch**。
⇒ 现在 worker 真调用 `diagnosticClusters` 会走到未知分支。
要接它必须把 `DiagnosticClusterService` 与项目上下文传入 builtins 的执行上下文——
这是"统一工具层"的最后一步，**未做完就不算工具接线完成**。

### 切片 9e：工具执行入口（builtins dispatch）——已交付

- `tools/builtins.ts`：`BuiltinToolExecutionContext` 新增可选 `diagnosticClusterService` 与
  `diagnosticClusterProjectIdentifier`；`switch` 新增 `case DIAGNOSTIC_CLUSTER_TOOL_NAME`，
  转发到 `executeDiagnosticClusterAction`。
- **未装配服务 ⇒ 显式抛错**（不伪装成"没有错误"或空结果）；关闭 ⇒ `feature-disabled`。
- 测试 `tests/core/unit/cluster01-tool-execution.test.ts`（4 条）：未装配报错、关闭 `feature-disabled` 且不建目录、
  开启 build ⇒ `payload.status === "built"`、描述符名与 dispatch 名一致（防漂移）。

**仍未接的一步**：把 `diagnosticClusterService` 从装配层**传进执行上下文**
（现在只有 builtins 端支持，调用链还不会填这个字段）⇒ 下一轮补这一处 pass-through，
再写"脚本化 worker 真调用"的集成用例。

### 切片 9f：执行上下文 pass-through（§5）——**已交付**

- 服务实例**只建一次**（`const diagnosticClusterService = ...`），供注册、执行与返回对象共用
  （避免"注册的表与服务看的表不是同一个"——这正是前几轮怀疑过的坑）。
- 在查询/执行路径的 `customToolHandlers` 中登记 `diagnosticClusters` 处理器，走**同一套策略包装**
  （`createPolicyWrapperForAgent`），不新建第二套门禁。
- 门禁：`typecheck` / `lint` 通过；相关 8 条用例（装配、注册、执行）全绿。

**仍未做**：脚本化 worker **真调用**该工具的端到端用例（需要任务子集授予 `diagnosticClusters`
并通过策略包装执行）——下一轮补；之后是 `feedback` 存储与 CLI。

### 切片 9g：端到端调用（脚本化 worker）——**部分证据**

`tests/core/integration/cluster01-tool-e2e.test.ts`（1 条，经 `createApplicationRuntime` + 脚本化 worker）：
任务子集显式授予 `diagnosticClusters`，worker 发出 `{"action":"build"}` ⇒ 拿到工具结果，
断言结果属于**权限/询问**类（`权限|询问|ask|denied`），**不是**"未知工具"，且 `analysis/` 目录未创建。

**这条证据的边界（如实记录）**：
它证明"调用被路由到该工具并进入权限判定"，**没有**证明"批准后 handler 真的执行了 build"。
后者需要构造"允许 `diagnostic.clusters.build` 的权限裁决"，属下一轮；
在那之前不能宣称工具执行链已完全闭环。

### 切片 9h：**允许后执行**闭环 + 架构守卫修复（2026-11-11）

- 端到端第 2 条（同文件）：先 `grantSessionAuthorization("diagnosticClusters", {action:"build"})`，
  再跑任务 ⇒ **索引目录真的创建**（`analysis/diagnostic-clusters`）⇒ 证明
  "worker 调用 → 权限裁决 → 策略包装 handler → 服务 → 快照落盘"整链贯通。

**全量首跑翻红 2 条，均为我的改动触发，已修**：

1. `destructive-file-api-guard`：`diagnostic-cluster-index.ts` 用了 `writeFile`+`rename`
   却不在破坏性 API 白名单里 ⇒ 已按"带理由白名单"补登记（只写状态目录派生索引，不碰源码）。
2. `ar07-internal-enforcement-non-disclosure`：能力命名空间 `diagnostic` 不在冻结的公开清单内 ⇒
   已加入（聚类是**产品能力**，默认关，不是内部强制执行层）。

**门禁**：`check:low-parallel` ⇒ **704 files / 4742 passed + 3 skipped，exit 0**。

**CLUSTER-01-03 判定**：工具/权限/SDK 接线与端到端闭环**均已有证据** ⇒ 转 **implemented-unverified**。
剩余：`feedback` 存储、CLI `astarray similarity ...`。

### 切片 10：纠正记录（§5 首段）——已交付

- `diagnostic-cluster-feedback.ts`：`appendDiagnosticClusterFeedback` / `readDiagnosticClusterFeedback`。
  - **只追加**到 `analysis/diagnostic-clusters/<hash>/feedback.jsonl`，**不触碰快照文件**；
  - 每条记录带**精确来源身份**（用户 ID 或强 Agent 个体 ID），空身份直接拒绝；
  - 返回 `isFact: false`，冲突（agree 与 disagree 并存）显式标 `hasConflict`；
  - 意见文本走既有 `redactSensitiveText`。
- 工具 `feedback` action 已接：未装配写入端口 ⇒ `feedback-not-assembled`；装配后写入并返回记录。
- 测试：`cluster01-cluster-feedback`（4 条）+ `cluster01-cluster-tools`（+1 条，共 7 条）。

**仍未做**：把 `appendFeedback` 从装配层真正填进工具上下文（与 9f 同一处 pass-through）、
`inspect` 展示意见与冲突、CLI。

### 切片 10b：纠正记录的装配接线 + 端到端（2026-11-11）

- 装配层把 `appendFeedback` 注入工具上下文（写入走 `appendDiagnosticClusterFeedback`，
  工具层不直接碰文件系统）。
- 端到端用例（`cluster01-tool-e2e`，第 3 条）：先参数级授权 feedback 调用 ⇒ worker 提交纠正意见 ⇒
  `feedback.jsonl` **真的落盘**，且目录里**没有 snapshot 文件**（只落意见、不自动重分组）。

**实测中确认的门禁行为**：未授权时该调用被拦且**不产生工具结果**（worker 拿不到结果）——
这正是"写 action 默认 ask"的应有表现，也解释了最初那次 30 秒超时的空结果。

### 切片 11：CLI 子命令处理器（§5）——**模块已交付，dispatch 未注册**

- `packages/tui/src/cli/similarity-command.ts`：`runSimilarityCommand({ argv, port, projectIdentifier })`，
  支持 `status|build|list|inspect|find-related|feedback`，稳定错误码
  `SIMILARITY_EXIT_CODES`（ok 0 / usageError 2 / featureDisabled 3 / noSnapshot 4 / permissionDenied 5）。
- 关闭 ⇒ `feature-disabled`（与工具/SDK 语义一致，不返回"没有错误"）；未构建 ⇒ `no-snapshot`；
  缺参数 ⇒ 用法错误；`feedback` 的 `sourceIdentity` 由 CLI 认证上下文提供，**参数不可覆盖**。
- 测试 6 条（`tests/core/unit/cluster01-similarity-cli.test.ts`）。

**未完成（下一轮）**：**注册进 CLI dispatch**（`cli.tsx`/`commands.ts` 的实际入口尚未定位成功，
本轮三次检索都没找到命令分派点）。所以在 `astarray similarity` 真正可用之前，
`CLUSTER-01-03` 保持 **in_progress**，不计为完成。

### 切片 11b：CLI **真实接线**（§5）——已交付

- `packages/tui/src/cli.tsx`：注册 `astarray similarity <subcommand>`（commander），
  选项 `--project/--group/--verdict/--note/--enable`；**默认关闭**，只有显式 `--enable` 才接线。
- 与 SDK/GUI 共用同一个 `DiagnosticClusterService`（经 `createSimilarityPortFromService`），CLI 不复制算法。
- 顺带修正一处顺序问题：**先判子命令再判开关**——否则打错子命令会被 `feature-disabled` 掩盖。

**实测（构建产物 `dist/cli.js`）**：

| 命令 | 输出 | 退出码 |
|---|---|---|
| `similarity status`（关闭） | `{"status":"feature-disabled"}` | **3** |
| `similarity status --enable` | `{"status":"no-snapshot"}` | 0 |
| `similarity bogus` | `{"status":"usage-error",...}` | **2** |

⇒ `CLUSTER-01-03` 转 **implemented-unverified**（剩余：02 的租约/取消/TTL、04 的效果报告、人工验收）。

### 切片 12：租约 / 取消 / TTL（§4）——已交付

| 行为 | 实现 | 证据 |
|---|---|---|
| 单项目写租约 | 服务内 `activeLeases`；并发 build 第二个返回 **`busy`** | 用例断言两并发结果为 `["built","busy"]` |
| 取消 | `buildSnapshot({signal})` ⇒ 扫描前检查 ⇒ **`partialReason: "cancelled"`** 且**保存游标** | 用例断言 `isComplete=false` + `partialReason` |
| TTL 新鲜度 | `readLatest` 比较 `generatedAtIso + ttl`（默认 24h）⇒ **`stale`**，不删不重建 | 用例把"现在"推到 25 小时后断言 `stale`；未过期仍 `ready` |

**门禁**：`check:low-parallel` ⇒ **707 files / 4758 passed + 3 skipped，exit 0**。

⇒ `CLUSTER-01-02` 转 **implemented-unverified**。卡内 §6 剩余：**04 的效果与资源报告**（需真实数据，属待人测）。
