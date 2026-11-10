# AUDIT-REPAIR-01 检查点 04：生产可达性分诊（2026-11-10）

## 0. 本报告的性质

这是**分诊记录**，不是"已交付"声明。分类口径按卡内固定六类：
已接入 / 需宿主注入 / 被替代 / 测试专用 / 未接入 / 证据不足。

**证据来源**：`scripts/audit-product-reachability.mjs` 实跑输出（候选 21 个，按生产提及升序），
外加对两个点名能力的**调用链**人工核对（不只看类名）。

## 1. 脚本实跑结果（原样摘录）

```
候选数 = 21（按「生产提及」升序；提及为 0 者最可疑）
  名称                                        生产提及  测试构造  门面提及  成员调用  定义文件
  AzureOpenAiAdapter                             0         4  否              0  runtime/azure-openai-adapter.ts
  BedrockConverseAdapter                         0         1  否              0  runtime/bedrock-converse-adapter.ts
  ContinuationCoordinator                        0         4  否              0  orchestration/agent-run-watchdog.ts
  FaultInjectionRecoveryVerifier                 0         1  否              0  orchestration/fault-injection-recovery-verifier.ts
  LocalCompletionVerifier                        0         5  否              0  orchestration/completion-verifier.ts
  AgentModelAssignmentController                 1         1  否              0  orchestration/agent-model-assignment-controller.ts
  AnthropicMessagesAdapter                       1         1  否              0  runtime/anthropic-gemini-adapters.ts
  BoundedProviderFallbackGuard                   1         1  否              0  orchestration/bounded-provider-fallback-guard.ts
  GeminiInteractionsAdapter                      1         1  否              0  runtime/anthropic-gemini-adapters.ts
  GenericOpenAiCompatibleAdapter                 1         2  否              0  runtime/openai-adapters.ts
  OpenAiChatCompletionsAdapter                   1         2  否              0  runtime/openai-adapters.ts
  OpenAiResponsesAdapter                         1         1  否              0  runtime/openai-adapters.ts
  QuaternaryPermissionIntersectionGuard          1         3  否              0  orchestration/quaternary-boundary-guards.ts
  TaskChainCumulativeBudgetController            1         1  否              0  orchestration/task-chain-cumulative-budget.ts
  SecondaryAgentSessionController                2         3  否              0  tools/main-agent-readonly-projection.ts
  HumanWorktreeObserver                          3         1  否              0  orchestration/human-worktree-observer.ts
  TertiaryAgentAssignmentPlanner                 3         1  否              0  orchestration/tertiary-lifecycle.ts
  TertiarySingleChainExecutionGuard              3         1  否              0  orchestration/tertiary-lifecycle.ts
  MetricsRegistry                                5         6  否              0  infra/metrics.ts
  AgentAddressGuard                              6        10  是              0  orchestration/agent-parent-binding-store.ts
  TokenMeasurementService                        6         8  是              0  measurement/token-measurement.ts
```

**注意**：`成员调用=0` 是**脚本的已知盲区**（它按 `实例.成员(` 计数，构造后转交/解构调用会漏计）。
因此下表的分类以**调用链人工核对**为准，脚本只用来找可疑项。

## 2. 两个点名能力（卡内 3、4）

### 2.1 `ToolDocumentationRecallController`

| 项 | 结论 |
|---|---|
| 定义 | `tools/tool-help-recall-controller.ts` |
| 真实构造 | `main-controller.ts:991`（`new ToolDocumentationRecallController({...})`） |
| 生产入口 | 主控制器内构造后供工具说明请求/回访使用（同文件 import `toolHelpRequestSchema` / `ToolHelpResponseV1`） |
| 权限包装 | 走工具端口既有门禁（该控制器只产说明文本，不安装工具） |
| 结论 | **已接入**（生产装配入口存在） |

**仍需补的证据（卡内完成判据）**：从应用装配入口验证**成功 / 拒绝 / 未知工具**三条路径，
并做"拔线"反例（移除装配后正向用例必须失败）。**本报告未做这三条**——列为本检查点的后继工作。

### 2.2 `AgentCommunicationDelegationController`

| 项 | 结论 |
|---|---|
| 定义 | `orchestration/agent-communication-delegation.ts` |
| 真实构造 | `main-controller.ts:1197` |
| 生产入口 | `main-controller.ts:906` `createGrant`、`:922` `assertDeliverable`、`:929` `assertNotReDelegable` |
| 权限包装 | 复用现有受认证控制面授权入口（`createGrant` 即授权契约），不新增默认全连接 |
| 结论 | **已接入**（有真实调用点，不只是构造） |

**仍需补的证据**：撤销 / 到期 / 关联 revision 变化后不可用；不透明句柄不可转授；
以及"拔线"反例。**本报告未做**——后继工作。

## 3. `DiskCache`

| 项 | 结论 |
|---|---|
| 定义 | `infra/cache.ts` |
| 组件状态 | **已实现且有 28 条测试**（见检查点 03 记录） |
| 产品接线 | **未接入模型执行链**（卡内 03 ⑦ 明确要求本批不接） |
| 结论 | **需宿主注入 / 未接入**（组件已验证，生产接线待选定确定性读操作与其敏感/权限策略后再做） |

**不得宣称**：缓存已带来命中收益。

## 4. 其余候选

| 候选 | 初步分类 | 后继工作（精确到下一步） |
|---|---|---|
| `AzureOpenAiAdapter` / `BedrockConverseAdapter` | 证据不足 | 查是否有工厂按 providerId 动态构造；若确无调用 ⇒ 标"未接入"并登记为产品缺口 |
| `ContinuationCoordinator` | 证据不足 | 查 `agent-run-watchdog` 是否为其宿主；`createWorkWindowTransitionMonitor` 曾同类 |
| `FaultInjectionRecoveryVerifier` | 测试专用（疑似） | 确认是否只在测试装配中出现 |
| `LocalCompletionVerifier` | 被替代（疑似） | 与完成收据门禁的关系：若收据已取代 ⇒ 标"被替代历史" |
| 其余 16 项 | 证据不足 | 逐项查调用链（含动态注册/别名/静态工厂/公开 SDK），**不在本批擅自接线** |

## 5. 结论（如实）

- 卡内 1、2 的**脚本可跑、输出结构化**：已完成；
- 卡内 3、4 的**接线判定**：两项均**已接入**（有构造与调用点）；
- 卡内 3、4 的**完成判据**（成功/拒绝/撤销三条路径 + 拔线反例）：**未做**；
- 其余候选：**只做了初步分诊**，未逐项定性。

⇒ 本检查点状态：**in_progress**，不是 done。

## 6. 完成判据核对（2026-11-10 续）：拔线反例**已有**

卡内完成判据要求"拔掉相应装配后正向测试必须失败"。核对发现该反例**已经存在**：

`tests/core/unit/wiring-manifest.test.ts`：

| 用例 | 作用 |
|---|---|
| "标 `constructed` 的组件必须在装配/编排源码里被构造（**被拔线 ⇒ 红**）" | 把装配移除 ⇒ 该用例失败 |
| "标 `unreachableByDesign` 的组件不得被构造（接了却没更新清单 ⇒ 红）" | 反向保护 |

清单里**已登记**两个点名能力：`AgentCommunicationDelegationController`（L98）、
`ToolDocumentationRecallController`（L104）。

行为面证据（`tests/core/unit/tool-recall-and-delegation.test.ts`，11 条）覆盖：

- 创建成功、句柄不透明、投递前失效检查；
- **不可转授**（句柄不可导出为另一句柄）；
- **撤销批量生效**；
- 层级校验（target 低一级、recipient 同级、target 存活）；
- 回执不继承、revision 变化重发、陈旧 revision 拒绝。

**实测**：两个文件 **14 passed**。

### 仍缺的唯一一条

卡内要求"从**应用或 SDK 的真实装配入口**验证成功 / 拒绝 / 撤销"。
现状是：**行为在单元层验证**（直接构造控制器）、**装配由清单守卫**，
但**没有一条用例经由 `createApplicationRuntime` 走完这条链**。

⇒ 04 仍为 **in_progress**，缺口精确到：**装配级行为用例（delegation 与 tool-recall 各一条）**。

## 7. 装配级用例（2026-11-10 续）：通信转交

新增 `tests/core/integration/audit04-delegation-assembly.test.ts`（2 条，走 `createApplicationRuntime`）：

| 用例 | 断言 | 结果 |
|---|---|---|
| **缺授权裁决引用 ⇒ 拒绝** | `userDecisionReference` 为空白 ⇒ 抛"授权/裁决"错误 | ✅ |
| **合法输入 ⇒ 产出不透明句柄** | 句柄非空、**不含对端身份串**、到期字段类型正确 | ✅ |

**过程中发现的一条真实约束**（此前未记）：`createGrant` 要求
**`recipientRole` 与 `grantorRole` 同级**（"recipient 必须与 grantor 同级"），
所以"上级 → 三级"这种跨级转交在入口处就被拒绝。这是**卡内 4 要的"仅有权直属上级转交给具体同级个体"**的落地证据。

**仍未覆盖**：完整投递校验（`DelegationValidationContext` 形状较大）与"撤销/到期/revision 变化后不可用"
在**装配层**的复现——单元层已有（`tool-recall-and-delegation` 的"grant 不可转授 + 撤销批量生效"）。

**门禁**：`check:low-parallel` ⇒ **688 files / 4672 passed + 3 skipped，exit 0**。

## 8. 撤销路径核对（2026-11-10 巡检）：**装配层没有撤销入口**

卡内 4 要求"撤销、到期和关联 revision 变化后不可使用"。核对结果：

| 层 | 事实 |
|---|---|
| 控制器 `AgentCommunicationDelegationController` | **有** `revokeGrant(grantId)`、`revokeAllForAgent(agentInstanceId)`（`agent-communication-delegation.ts:73/77`） |
| 投递复检 | `assertDeliverable` 在 `:220` 检查 **`input.context.isRevokedByUser`** —— 撤销状态由**调用方传入** |
| `main-controller` 生产入口 | **只有**：`createGrant`(:906)、`assertDeliverable`(:922)、`assertNotReDelegable`(:929)。**没有撤销入口** |

⇒ 结论：**撤销能力存在，但装配层未暴露入口**，且投递复检依赖调用方自己提供"是否已撤销"。

**这属于卡内的"需宿主注入/未接入"，不是测试缺口**——因此本轮**没有**写"撤销后不可用"的装配级用例：
那种用例只能直接构造内部控制器，与既有单元用例重复，无法证明装配可达性。

**后继工作（精确）**：
1. 在 `main-controller` 暴露 `revokeCommunicationDelegationGrant(handleIdentifier)`（转发到 `revokeGrant`）；
2. 投递复检改为**从存储读取撤销状态**，而不是要求调用方传 `isRevokedByUser`
   （否则调用方漏传即绕过撤销）；
3. 再补装配级用例：创建 ⇒ 撤销 ⇒ 复检必须拒绝；
4. 到期与 revision 变化两条同理。

## 9. **更正 + 撤销入口已补齐**（2026-11-10 第十九轮）

### 更正上一条错误结论

上一轮我写了「`assertDeliverable` 依赖调用方传入 `isRevokedByUser`，**调用方漏传就可能绕过撤销**」。
**这是错的**：撤销是 `grantStore.revokeGrant` **删除授权记录**，而 `assertDeliverable` 第一步
`getGrantByHandle` 取不到就抛「沟通句柄不存在或已撤销」（`:205-212`）。
⇒ 撤销**不依赖**调用方那个 flag，flag 只是额外的一层。**该结论已作废。**

### 补齐的入口

| 位置 | 新增 |
|---|---|
| `AgentCommunicationDelegationController` | `revokeByHandle(handle)`、`revokeAllForAgent(agentId)` |
| `MainController` | `revokeCommunicationDelegationGrant(handle)`、`revokeAllCommunicationDelegationsForAgent(agentId)` |

### 新增装配级用例（3 条，全绿）

```text
创建授权 ⇒ revokeCommunicationDelegationGrant(handle) 返回 true
         ⇒ 再撤一次返回 false（已不存在，不抛错）
         ⇒ assertCommunicationDelegationDeliverable 抛「不存在或已撤销」
```

**实测**：`audit04-delegation-assembly` ⇒ **3 passed**；全量见下一节。

⇒ 卡内 4 的"**撤销后不可使用**"现在**装配层可达且有证据**。
到期与 revision 变化两条仍待补。

## 10. 到期与 revision 变化（2026-11-10 第二十轮）：装配级已证

新增两条用例（`audit04-delegation-assembly`）：

| 用例 | 断言 |
|---|---|
| profile revision 变化 | 同 revision 下**可投递**（先证明基线）；`revision + 1` ⇒ 抛 `revision` |
| 已到期 | `expiresAtIso` 设为过去 ⇒ 抛 `到期` |

**关键写法**：revision 用例先断言"基线可投递"，否则"拒绝"可能来自别的原因（比如上下文非法）——
这是避免假阳性的必要一步。

**实测**：`audit04-delegation-assembly` ⇒ **5 passed**。

### 04 完成判据现状（delegation 一侧）

| 判据 | 状态 |
|---|---|
| 成功 | ✅ 创建授权 + 投递基线 |
| 拒绝 | ✅ 缺授权引用、跨级转交（同级规则） |
| 撤销 | ✅ **本轮**（撤销入口 + 复检拒绝） |
| revision 变化 | ✅ **本轮** |
| 到期 | ✅ **本轮** |
| 拔线反例 | ✅ 既有 `wiring-manifest`（构造即要求） |

**仍缺**：`ToolDocumentationRecallController` 的装配级三条路径（成功/拒绝/未知工具）。
⇒ 04 仍 **in_progress**，但 delegation 一侧的判据已全部有证据。

**门禁**：`check:low-parallel` ⇒ **688 files / 4675 passed + 3 skipped，exit 0**
（首轮 `g4-tool-documentation-e2e` 翻红，隔离复跑 2/2 通过 ⇒ 记为**已知抖动**，未改断言；重跑全绿）。

## 11. 工具说明回访（2026-11-10 第二十一轮）：入口可达，缺 revision 取值

用装配级用例（`controller.answerToolHelpRequest`）实测得到：

| 观察 | 含义 |
|---|---|
| 请求体字段不全 ⇒ `resolution: "rejected"` | 入口对**非法请求**明确拒绝（不是抛错） |
| 补全字段（`controlEventType`/`requestIdentifier`/`taskExecutionIdentifier`/`requestKind`/`toolIdentifier`/`capabilityIntent`/`blockingReason`/`knownToolGroupRevision`）后 ⇒ `resolution: "stale-request"` | **入口确实在生产装配里工作**，只是我给的 `knownToolGroupRevision` 与当前工具组 revision 不一致 |

⇒ 结论：`ToolDocumentationRecallController` 的**装配入口可达**（有真实响应，不是"不可达"）。
缺的只是"当前工具组 revision"的正确取值来源。

**本轮未留下该用例**：为避免把"revision 猜错"写成失败测试，文件已删除；
下一轮第一步：在 `answerToolHelpRequest` 附近定位 revision 的权威来源
（对比 `knownToolGroupRevision` 的比较点），再用正确值断言
`usage-provided` / `known-but-not-usable` / `escalated-missing-tool` 三条。

## 12. 工具说明回访（第二十二轮）：请求已进判定，仍差"分配集合"语义

定位到陈旧检查口径：`tool-help-recall-controller.ts:185`
`request.knownToolGroupRevision < currentToolGroupRevision ⇒ stale`（**只拒绝落后**）。
按此把请求版本号取为不小于当前值后，请求**真正进入分配判定**：

| 请求 | 实际 resolution |
|---|---|
| 任务链里声明的工具（`readFile`） | **`known-but-not-usable`** |
| 不存在的工具 | 未跑到（前一条先失败） |

`known-but-not-usable` 的语义是"注册表有、但**不属于请求者可用集合**"。
但该工具确实出现在任务 `toolNames` 里 ⇒ 说明**分配集合的取法**与我的假设不同，
可能是：请求者身份（`requesterAgentInstanceId`）与任务的 `assignedAgentId` 不匹配，
或分配集合另有人权限来源（profile/allowedToolNames）。

**本轮仍未留下用例**（第二次）：现在写死任何断言都可能是在验证我的错误假设。
**下一轮第一步**：读 `answerToolHelpRequest` 里 `assignedDocumentation` 的完整构造与
`known-but-not-usable` 的判定分支，确定"请求者可用集合"的真实来源，再一次性写对三条用例。

**代价说明（如实）**：这一小项已经花了三轮（第 21、22 轮各一次失败），
比预期高；如果下一轮仍不能一次写对，我会把它标为"需更深入了解，另开专项"，
转去做收益更高的项，而不是继续在这里打转。

## 13. 根因找到（第二十三轮）：**文档登记表需宿主注入**，不是缺陷

读了 `answerToolHelpRequest` 的完整构造（`main-controller.ts:988-1012`），三点决定性事实：

1. `currentToolGroupRevision: mission.taskChain.revision` —— 陈旧检查用的是**任务链 revision**（动态值）；
2. 分配集合来自任务 `toolNames` ∩ `registry.getDescriptor(...)`；
3. **`buildToolPublicDocumentation` 抛错 ⇒ `catch` 静默跳过 ⇒ 该工具视为"未分配"**（fail-closed，
   注释原文："公开用法登记不完整 ⇒ 不暴露半套说明"）。

而 `application-runtime.ts:853` 的 `toolDocumentationRegistry` 是**注入选项**。
装配级用例里没注入它 ⇒ 每个工具都走 catch ⇒ 全部"未分配" ⇒ 于是返回
`known-but-not-usable`。

⇒ **`known-but-not-usable` 不是缺陷，是"宿主未注入文档登记表"的正确表现。**

### 分类更正

| 能力 | 原分类 | 更正 |
|---|---|---|
| `ToolDocumentationRecallController` | 已接入 | **已接入 + 需宿主注入（`toolDocumentationRegistry`）** |

### 下一轮（一步到位，不再试错）

装配级用例里注入最小 `toolDocumentationRegistry`（给一个已分配工具写完整登记项），
并让 `knownToolGroupRevision` 取 `mission.taskChain.revision`（不要再用 999999），
然后断言 `usage-provided` / `known-but-not-usable` / `escalated-missing-tool` 三条。

**三轮的教训**：我应该在第 21 轮就先读这段构造（30 行），而不是先写测试撞两次。

## 14. 工具说明回访：**装配级已证**（2026-11-10 第二十四轮）

按上一轮的根因**一次写对**：注入 `toolDocumentationRegistry` + `knownToolGroupRevision = taskChain.revision`。

新增 `tests/core/integration/audit04-tool-help-assembly.test.ts`（1 条，含两段断言）：

| 断言 | 结果 |
|---|---|
| 已分配工具（`readFile`）⇒ `usage-provided`，返回该工具用法，且 **`isAuthorizationGranted === false`** | ✅ |
| 未知工具（`usage-help` 语义）⇒ `known-but-not-usable`，**不返回 schema**，且**不当成 missing-capability** | ✅ |

**语义澄清**（修正我上一轮的猜测）：`escalated-missing-tool` 属 `missing-capability` **请求**，
不是"未知工具名"的默认结果；`usage-help` + 未知工具名 ⇒ `known-but-not-usable`。

**门禁**：`check:low-parallel` ⇒ **689 files / 4676 passed + 3 skipped，exit 0**。

### 04 完成判据现状

| 判据 | 状态 |
|---|---|
| delegation：成功 / 拒绝 / 撤销 / revision / 到期 / 拔线 | ✅ 全部有装配级或清单证据 |
| tool-recall：已分配 ⇒ 用法；未知 ⇒ 不泄露 schema | ✅ **本轮** |
| tool-recall：`missing-capability` ⇒ 向上级反馈 | ⬜ 仍缺（请求类型不同，需另写一条） |

⇒ 04 **in_progress**，只差最后一条。

## 15. 04 完成判据**全部有证据**（2026-11-10 第二十五轮）

补上最后一条（`missing-capability` 请求 ⇒ 向上级反馈）：

```text
requestKind: "missing-capability", toolIdentifier: null,
capabilityIntent: "需要访问远端仓库", blockingReason: "no-known-match"
⇒ resolution = "escalated-missing-tool"，escalationIdentifier 非空
```

### 判据总表

| 判据 | 证据位置 | 状态 |
|---|---|---|
| delegation 成功 | `audit04-delegation-assembly`（创建 + 投递基线） | ✅ |
| delegation 拒绝 | 同上（缺授权引用、跨级转交） | ✅ |
| delegation 撤销 | 同上（撤销入口 + 复检拒绝） | ✅ |
| delegation revision 变化 | 同上 | ✅ |
| delegation 到期 | 同上 | ✅ |
| tool-recall 已分配 ⇒ 用法 | `audit04-tool-help-assembly` | ✅ |
| tool-recall 未知工具 ⇒ 不泄露 schema | 同上（`known-but-not-usable`） | ✅ |
| tool-recall 能力缺失 ⇒ 向上级反馈 | 同上（本轮，`escalated-missing-tool`） | ✅ |
| 拔线反例 | `wiring-manifest`（被拔线 ⇒ 红） | ✅ |
| DiskCache 状态 | 组件已验证、**生产未接入**（03 ⑦ 边界） | ✅ 已如实标注 |

**门禁**：`check:low-parallel` ⇒ **689 files / 4676 passed + 3 skipped，exit 0**。

### 结论

04 的**完成判据已全部有证据** ⇒ 转 **implemented-unverified**。
**仍不宣称"产品已达生产可用"**：`DiskCache` 未接生产、其余 16 个候选只做了初步分诊，
这些都在本报告第 4 节列为后继工作。

## 16. 候选逐项分诊（第一批 5 个，2026-11-10 第二十七轮）

对脚本里"生产提及 = 0"的前 5 个候选做调用链核对（`git grep` 生产与测试两侧，并读定义处注释）：

| 候选 | 生产出现位置 | 判定 | 依据 |
|---|---|---|---|
| `AzureOpenAiAdapter` | **仅定义文件自身** `runtime/azure-openai-adapter.ts:34` | **未接入** | 全仓库没有第二处构造/引用；provider 工厂未接它 |
| `BedrockConverseAdapter` | **仅定义文件自身** `runtime/bedrock-converse-adapter.ts:122` | **未接入** | 同上 |
| `ContinuationCoordinator` | `agent-run-watchdog.ts` 里的**接口与注释** | **未接入（仅契约）** | 只有 `ContinuationCoordinatorOptions` 接口，无实现被构造 |
| `FaultInjectionRecoveryVerifier` | **仅定义文件自身** | **测试专用** | 生产无引用；测试里有构造（故障注入验证器） |
| `LocalCompletionVerifier` | 其他文件仅**注释提及** | **被替代** | `completion-receipt.ts:9` 注释原文："`LocalCompletionVerifier` 至今**零调用方**"；完成收据门禁已取代它 |

**后继工作（精确）**：
1. `AzureOpenAiAdapter`/`BedrockConverseAdapter`：确认 provider 选择链路是否**应当**支持这两家；
   若应当 ⇒ 属产品缺口（接线）；若不应当 ⇒ 标"未接入且无计划"，避免长期飘着；
2. `ContinuationCoordinator`：确认"检查点续跑"是否已有替代（`continuation-breakpoint` 系列）；
   有 ⇒ 标被替代；无 ⇒ 订一个"契约无实现"的缺口；
3. `FaultInjectionRecoveryVerifier`：标测试专用即可，不进产品能力清单；
4. `LocalCompletionVerifier`：标"被替代历史"，按卡内要求**保留不删除**。

**说明**：其余 11 个候选（生产提及 1–6）尚未逐项核对；本批刻意只做 5 个，
避免一次性下结论却没有逐个读调用链。

## 17. 候选逐项分诊（第二批 10 个，2026-11-10 第二十八轮）

核对方式同上：`git grep -l <类名> -- packages/core/src`，看**是否出现在自身定义文件之外**。

| 候选 | 生产出现文件 | 判定 |
|---|---|---|
| `AgentModelAssignmentController` | 仅 `agent-model-assignment-controller.ts` | **未接入** |
| `AnthropicMessagesAdapter` | 仅 `anthropic-gemini-adapters.ts` | **未接入** |
| `GeminiInteractionsAdapter` | 仅 `anthropic-gemini-adapters.ts` | **未接入** |
| `BoundedProviderFallbackGuard` | 仅 `bounded-provider-fallback-guard.ts` | **未接入** |
| `QuaternaryPermissionIntersectionGuard` | 仅 `quaternary-boundary-guards.ts` | **未接入** |
| `TaskChainCumulativeBudgetController` | 仅 `task-chain-cumulative-budget.ts` | **未接入** |
| `HumanWorktreeObserver` | 仅 `human-worktree-observer.ts` | **未接入** |
| `TertiaryAgentAssignmentPlanner` | 仅 `tertiary-lifecycle.ts` | **未接入（同文件内使用）** |
| `TertiarySingleChainExecutionGuard` | 仅 `tertiary-lifecycle.ts` | **未接入（同文件内使用）** |
| `OpenAiChatCompletionsAdapter` | `openai-adapters.ts` + 被 `azure-openai-adapter.ts` 继承 | **未接入**（有继承关系，但无外部构造点） |

**共同形态**：这些类**都有实现与单元测试，但没有任何生产装配点**。
按卡内要求，这**不能算"已交付"**——"存在源码"不等于可达。

**后继工作（按组）**：
1. **Provider 适配器组**（`AnthropicMessagesAdapter`/`GeminiInteractionsAdapter`/`OpenAiChatCompletionsAdapter`/
   `AzureOpenAiAdapter`/`BedrockConverseAdapter`）：需确认 provider 选择链路是否**应**支持这些后端；
   若应 ⇒ 属产品缺口；若不应 ⇒ 标"未接入且无计划"。
2. **边界/预算守卫组**（`QuaternaryPermissionIntersectionGuard`/`TaskChainCumulativeBudgetController`/
   `BoundedProviderFallbackGuard`）：确认是否已被现有门禁替代；被替代 ⇒ 标历史并保留。
3. **生命周期组**（`HumanWorktreeObserver`/`TertiaryAgentAssignmentPlanner`/`TertiarySingleChainExecutionGuard`）：
   同文件内使用＝只在构造文件内部闭环，需确认是否应挂到 `tertiary-lifecycle` 的生产装配。
4. `AgentModelAssignmentController`：与已有的 `setAgentModelBinding` 门面方法比对，确认是否被替代。

**本批仍未做**：`MetricsRegistry`、`AgentAddressGuard`、`TokenMeasurementService`（生产提及 5–6，
最可能是"已接入但脚本计数偏低"，下一批用调用链确认）。
