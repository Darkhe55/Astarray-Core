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
