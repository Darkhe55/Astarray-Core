# CLUSTER-01：实验性错误聚类与相似案例检索

日期：2026-11-10。状态：pending。本卡是编码规格，不是已实现或已验收声明。
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
| CLUSTER-01-01 | 契约/开关/作用域适配器/有界诊断读取/来源引用与脱敏 | pending |
| CLUSTER-01-02 | 确定性算法、索引、预算、租约、取消、检查点、TTL | pending |
| CLUSTER-01-03 | 统一工具、权限判定、运行时、SDK、CLI 真实接线及反馈存储 | pending |
| CLUSTER-01-04 | 行为反例、隔离安装包验收、效果与资源报告 | pending |

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
