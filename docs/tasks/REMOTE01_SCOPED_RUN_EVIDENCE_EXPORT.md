# REMOTE-01：受控运行记录导出与远程投递契约
日期：2026-10-28。状态：in_progress（01–03 全部部分交付，implemented-unverified；整卡未闭合）。

执行规则：每轮只做一个编号检查点，超过三小时拆分；先核对当前代码和在途改动，已有能力复用。覆盖、删减前由工具备份；不覆盖他人工作。必须更新本卡状态和交付记录；共享台账存在并行冲突时提交独立状态补丁，不以未授权为由跳过状态记录。本卡不授权安装、真实付费模型调用、外发消息、提交推送或自动启用实验功能。需要依赖时先询问已有资源。沿用用户此前不要求编写/运行测试的交付口径，本卡列出验收条件但不自行执行测试或宣称通过；代码完成只能标 implemented-unverified。变量名必须可读，时间单位明确。公共核心只放通用契约，不复制私有界面实现或设计。

## 定位和现状
秘书已有 secretary-agent-contract.ts、secretary-relay-contract.ts、secretary-policy.ts，默认关闭，只允许 read-only-report-query/status-query，不读项目源文件或私人记忆。当前检索未找到完整的会话片段制图到 IM 图片发送链路；不能把纯判定契约或 SDK 导出当成产品已支持。
此卡仅定义公共数据、授权和投递端口，不包含任何客户端图像布局。用户场景：不在电脑前，通过已连接设备查阅项目实际运行情况并取得依据。

## 01：项目持有者出具只读记录
增加 requestRunEvidence 操作，经项目控制面出具不可变 EvidenceSnapshot。秘书仅发请求/读取获准结果，不直接读取其他 Agent 档案。绑定 requestIdentifier、projectIdentifier、conversationIdentifier、选定 messageIdentifiers/时间区间、snapshotRevision、capturedAt、lastObservedAt、sourceAgentInstanceIdentifiers、来源类型和记录引用。
明确区分用户原话、模型自述、工具调用、真实工具结果、产物登记/落盘证据、审查结论；没有证据标未知，任务 done 与验收通过分开。遗漏/脱敏/截断显式标记。只包含已保存可展示记录，不生成或索取模型隐藏思维链。
默认原文摘录；摘要必须独立注明派生、覆盖范围和原文引用，不冒充原始回执。项目离线提供 last-known，禁止标实时。

## 02：远程主体、权限与双步骤
首次绑定由认证用户单独确认账户/设备，返回明确授权范围：允许哪些项目、哪些记录类别、期限、发送目标。IM 来信不自动等于认证用户：验证平台签名/时间戳/重放、账户绑定、设备可识别能力；平台不提供设备标识时只能承诺账户/聊天授权，不能伪称设备级绑定。
设备请求在有效预授权范围内可直接得到记录，不要求用户回电脑重复批准；越范围在已有可信通道发独立短授权请求，不能自批、不能仅凭相同聊天昵称扩权。跨项目读取仍按原项目授权；读取授权不自动等于对外发送授权。
拆为 prepareEvidenceExport 和 deliverEvidenceExport；秘书模型只提案，可信本地控制面渲染/发出。为新能力增加窄范围允许项，不改为任意文件读取、桌面抓屏或通用 HTTP 工具。

## 03：投递与可靠性
首版只实现通用端口与本地假适配器；真实 IM 平台未指定，登记为待用户选择，不自行接入付费服务或建立外部账号。
投递幂等键包含请求、目标、snapshotRevision、导出内容摘要（非秘密值）；复用持久 outbox，记录 queued/sending/sent/unknown/failed。超时若平台不支持幂等与查询则 unknown，不盲目重发；平台确认仅表示接收，不声称用户已看到。
发送前复核授权撤销、内容版本、SEC-02 完整扫描结果和目标绑定。鉴权凭证只通过本地凭证端口解析，不进入模型/事件/导出。断网有界重试且过期不补发，用户请求可取消。远程查看不得恢复、调度或修改项目。
数据落秘书专属域，保留溯源清单；清理遵守既有备份/风险操作规则，不引入“过期删除豁免”。已发送内容不可保证从第三方设备撤回，授权说明必须体现。

## 验收条件（待验证）
错项目/错设备/过期/重放/撤销请求无输出；离线标旧数据；模型说成功但工具失败不输出成功结论；脱敏不污染原档案；重启 outbox 不重复发送；unknown 不假成功；同一快照可对账；无平台适配器明确 unsupported。
前驱：稳定会话身份、SEC-02 外发门禁；默认实验秘书仍关闭，新增能力不会隐式启用秘书。


## 检查点记录

### 01 只读运行记录快照（EvidenceSnapshot）——**部分交付**（2026-10-28）

**审查发现**：仓库里**没有** `requestRunEvidence`，也没有快照契约；数据散在 mission 摘要/任务链、
运行历史、产物登记、报告索引里，**没有来源分型、没有内容哈希、没有不可变语义**。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 快照契约 | `packages/core/src/orchestration/remote-evidence-snapshot.ts` | 七类来源分型（无"隐藏思维链"类型，结构上不可表达）；逐条 `recordReference/recordedAtIso/sourceAgentInstanceIdentifier`；600 字符截断标记；摘要派生标记 + 覆盖条数；`isRealtime` 恒 false；`lastObservedAt` 取记录最新时间；确定排序 + `contentHash` + 完整性校验 |
| 控制面入口 | `main-controller.ts` `requestRunEvidence` | 汇聚 mission 摘要/任务链、运行历史、产物登记、报告索引；来源不可用只写 `omissions.reasonCodes`，**不补占位条目**；时间区间过滤 |

**未做（如实）**：**没有不可变存储**（快照只作为返回值，revision 仅在进程内递增、重启归零）；
**`messageIdentifiers` 未生效**（无消息级索引）；**没有授权绑定**（谁能请求/看哪些 mission 未校验）；
**不脱敏**（原文摘录，投递前须过 SEC-02-04）；来源粒度粗（运行历史无 agent 归属、任务状态无独立时间戳）；
未跑任何构造路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 02 远程主体绑定、范围与双步骤投递——**部分交付**（2026-10-28）

**审查发现**：仓库里只有默认关闭的秘书契约（纯类型），**没有**远程主体绑定、没有入站核验、
没有 prepare/deliver 拆分、没有范围模型。

**交付**：
| 要点 | 位置 | 说明 |
|---|---|---|
| 绑定契约 + 存储 | `remote-evidence-export.ts` `RemoteIdentityBinding` / `RemoteIdentityBindingStore` | `authenticatedUserId`（非昵称）、设备可为 null、授权项目/记录类别（窄 5 类）、期限、撤销 |
| 入站核验 | `verifyRemoteInboundMessage` | 顺序拒绝：签名 → 重放 → 时间戳偏移（缺省 300s）→ 账户未绑定 → 过期/撤销 → 设备不符；通过给 `account-and-device` / `account-only` |
| 范围判定 | `evaluateRemoteExportScope` | 三态：预授权内 / **需要独立批准（逐条原因）** / 拒绝；**无自批入口** |
| 双步骤 | `prepareEvidenceExport` / `deliverEvidenceExport` | 准备由**可信控制面渲染**；投递只接受准备产物、**再次复核范围**、不接受模型文本 |
| 窄范围 | 同文件 | 不新增任意文件读取/桌面抓屏/通用 HTTP；内容只来自快照 |

**未做（如实）**：**无平台适配器**（`platformSignatureValid` 是调用方传入的布尔声明，真正 IM 验签未实现）；
**无首次绑定流程**（谁有权写绑定未约束）；**无独立短授权通道**（只返回"需要批准"）；
**运行时未接线**；投递幂等只靠端口承诺（属 03）；未跑任何一条拒绝/放行路径。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 03 幂等 outbox 与 unknown 语义——**部分交付**（2026-10-28）

**审查发现**：此前投递只有一句"端口必须幂等"的注释 —— 没有稳定 operation id、没有回执读取、
没有 unknown 状态、也没有"目标不可改"约束。**平台受理但未送达时，调用方会把"已受理"当成"已送达"**。

**交付**（`remote-delivery-outbox.ts`）：
| 要点 | 说明 |
|---|---|
| 稳定标识 | `operationIdentifier` + `interactionRevision` + `contentHash` + `authorizationRevision` |
| 不完整不发送 | 必填/格式/长度/`sha256:<64hex>`/授权 revision 逐项校验，不完整 `enqueue` 直接抛错 |
| 入队幂等 | 同 id 同内容 ⇒ 返回既有；**同 id 不同内容/目标/修订 ⇒ 拒绝** |
| 先读回执 | `attemptRemoteDelivery` 先 `readReceipt`；明确 ack ⇒ sent；**受理后无回执 ⇒ unknown** |
| unknown 语义 | `unknown` 不自动重发，只有**显式** `isResendAfterUnknown` 才重试 |
| 目标不可变 | `assertRemoteDeliveryTargetUnchanged`；换目标须新 operation + 新授权 |
| 落盘 | `<state>/remote-delivery/outbox.json`（原子写 + 互斥 + 备份恢复） |
| 接线 | `deliverEvidenceExport` 装配 outbox+transport 时走该路径，否则保留旧路径 |

**未做（如实）**：**无真实传输适配器**（发送/回执端口只有契约，IM 未接）；
**无定时重试/退避**；**无 unknown 处置入口**（没有 CLI/UI 读回执/确认重发/取消）；
`authorizationRevision` 由调用方提供、递增语义未固化；运行时未构造 outbox/transport；
未跑"重复入队/同 id 换内容被拒/受理后无回执 ⇒ unknown/unknown 不自动重发/换目标被拒"任何一条。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。
