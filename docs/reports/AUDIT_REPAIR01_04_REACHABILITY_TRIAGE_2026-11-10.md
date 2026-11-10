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
