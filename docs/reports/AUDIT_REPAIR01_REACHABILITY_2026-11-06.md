# AUDIT-REPAIR-01 检查点 04：生产可达性分诊（2026-11-06）

审计基线：`c706e7a5`（本轮开始前的 HEAD）。
脚本：`node scripts/audit-product-reachability.mjs --json`（新增结构化输出；候选数量变化不使构建失败）。

## 1. 结论口径

| 分类 | 含义 |
|---|---|
| 已接入 | 生产装配有真实构造与调用入口 |
| 需宿主注入 | 公开 SDK 导出，由宿主/嵌入方提供 |
| 被替代 | 存在等价的生产实现，旧类保留但不再接线 |
| 测试专用 | 只在测试中构造，无产品语义入口 |
| 未接入 | 有实现与测试，但生产无构造/入口 |
| 证据不足 | 本轮未逐条读调用链，不能下结论 |

## 2. 候选分诊（24 个，按生产提及升序）

| 候选 | 生产提及 | 测试构造 | SDK | 成员调用 | 初步分诊 | 说明 |
|---|---|---|---|---|---|---|
| `AgentCommunicationDelegationController` | 0 | 1 | 否 | 0 | **未接入（本检查点目标）** | 需接现有受认证授权入口与通信路由 |
| `AzureOpenAiAdapter` | 0 | 4 | 否 | 0 | 测试专用（待核） | 未发现生产装配 |
| `BedrockConverseAdapter` | 0 | 1 | 否 | 0 | 测试专用（待核） | 同上 |
| `ContinuationCoordinator` | 0 | 4 | 否 | 0 | 测试专用（待核） | watchdog 组件，未见生产入口 |
| `DelegatedAgentCommunicationGrantStore` | 0 | 1 | 否 | 0 | 未接入（同上目标） | 与 delegation controller 配套 |
| `FaultInjectionRecoveryVerifier` | 0 | 1 | 否 | 0 | 测试专用 | 故障注入验证器 |
| `LocalCompletionVerifier` | 0 | 5 | 否 | 0 | 被替代（待核） | 生产完成门禁在 MainController，未构造此处 |
| `ToolDocumentationRecallController` | 0 | 1 | 否 | 0 | **未接入（本检查点目标）** | 需接工具说明请求/反馈入口 |
| `AgentModelAssignmentController` | 1 | 1 | 否 | 0 | 证据不足 | 仅模块提及，未见构造 |
| `AnthropicMessagesAdapter` | 1 | 1 | 否 | 0 | 被替代（待核） | 生产用 AnthropicMessagesRuntime |
| `BoundedProviderFallbackGuard` | 1 | 1 | 否 | 0 | 证据不足 | |
| `GeminiInteractionsAdapter` | 1 | 1 | 否 | 0 | 测试专用（待核） | |
| `GenericOpenAiCompatibleAdapter` | 1 | 2 | 否 | 0 | 被替代（待核） | 生产用 OpenAiCompatibleRuntime |
| `OpenAiChatCompletionsAdapter` | 1 | 2 | 否 | 0 | 被替代（待核） | 同上 |
| `OpenAiResponsesAdapter` | 1 | 2 | 否 | 0 | 测试专用（待核） | |
| `QuaternaryPermissionIntersectionGuard` | 1 | 3 | 否 | 0 | 测试专用（待核） | |
| `TaskChainCumulativeBudgetController` | 1 | 1 | 否 | 0 | 证据不足 | |
| `SecondaryAgentSessionController` | 2 | 3 | 否 | 0 | 证据不足 | 只读投影中出现名称 |
| `HumanWorktreeObserver` | 3 | 1 | 否 | 0 | 证据不足 | |
| `TertiaryAgentAssignmentPlanner` | 3 | 1 | 否 | 0 | 证据不足 | 生命周期模块内提及 |
| `TertiarySingleChainExecutionGuard` | 3 | 1 | 否 | 0 | 证据不足 | |
| `MetricsRegistry` | 5 | 6 | 否 | 0 | 证据不足（可能已接入） | 需查实际构造点 |
| `AgentAddressGuard` | 6 | 10 | **是** | 0 | 需宿主注入（待核） | SDK 导出 |
| `TokenMeasurementService` | 6 | 8 | **是** | 0 | 需宿主注入（待核） | SDK 导出 |

> 上表是**启发式 + 初步分诊**；"待核"表示尚未逐条读调用链。检查点 04 尚未关闭。

## 3. 本检查点要接线的两项（已确认零生产入口）

### 3.1 `ToolDocumentationRecallController`

- 文件：`packages/core/src/tools/tool-help-recall-controller.ts`
- 现状：有请求 schema、响应/升级协议与测试，但生产无构造。
- 接线点：工具说明请求/反馈的生产入口（首次完整下发、后续标准回访、命中返回用法、不存在向直属上级反馈）。
- 约束：回访不得自动安装工具或扩大权限；响应 `isAuthorizationGranted` 恒 false。
- 计划：在 `application-runtime` 构造控制器，把现有工具说明请求路由（若存在）指向它；
  无现成路由时新增最小的受认证请求入口并补失败测试。

### 3.2 `AgentCommunicationDelegationController`

- 文件：`packages/core/src/orchestration/agent-communication-delegation.ts`
- 现状：grant store + 控制器 + 失效检查 + 测试，但生产无构造。
- 接线点：现有受认证控制面授权入口 + 通信路由。
- 约束：只有权直属上级转交给具体同级；不透明句柄不得转授；不转移任务/记忆/工具权限；
  撤销/到期/revision 变化后不可用；不新增默认全连接。
- 计划：复用现有授权契约，接一个明确的 SDK/控制面入口；拒绝路径优先写测试。

### 3.3 `DiskCache`

- 本批只核查并如实标记：**组件已验证（检查点 03），生产接线未完成**；未选定确定性读操作前不泛化接入。

## 4. 后继工作（不在本批编码范围）

- 其余候选逐个读调用链，补"设计条款/构造/入口/权限包装/测试/导出"六列表；
- 对"被替代"候选记录替代实现与旧类保留位置，不删除；
- 对"测试专用"候选确认无产品语义入口，必要时归档而不是接线；
- 对"证据不足"候选补证据后再分类，禁止用源码存在当作交付。

## 5. 复现

```powershell
node scripts/audit-product-reachability.mjs --json
```

## 6. 最终分诊（脚本 + 定向 grep，2026-11-06）

证据列：`new` = 生产构造命中；`mention` = 生产模块提及；`sdk` = public-sdk 导入；`test` = 测试构造数。

| 候选 | 最终分类 | 证据 |
|---|---|---|
| `AgentCommunicationDelegationController` | **已接入** | `new` main-controller.ts:1007；SDK 方法 |
| `DelegatedAgentCommunicationGrantStore` | **已接入** | `new` main-controller.ts:1006 |
| `ToolDocumentationRecallController` | **已接入** | `new` main-controller.ts:956；SDK 方法 |
| `AgentAddressGuard` | **需宿主注入** | sdk 导入（public-sdk.ts:115） |
| `TokenMeasurementService` | **需宿主注入** | sdk 导入（public-sdk.ts:825） |
| `AzureOpenAiAdapter` | **被替代** | 无生产构造；生产用协议运行时直接实现 |
| `AnthropicMessagesAdapter` | **被替代** | 同上；`AnthropicMessagesRuntime` 为生产实现 |
| `GenericOpenAiCompatibleAdapter` | **被替代** | 无生产构造；`OpenAiCompatibleRuntime` 为生产实现 |
| `OpenAiChatCompletionsAdapter` | **被替代** | 无生产构造；仅被 Azure 适配器继承（同样未构造） |
| `OpenAiResponsesAdapter` | **被替代** | 无生产构造 |
| `LocalCompletionVerifier` | **被替代（待核）** | 零构造；完成门禁在 MainController/编排层另行实现 |
| `MetricsRegistry` | **未接入** | 生产无 `new MetricsRegistry(`；仅测试构造 |
| `BedrockConverseAdapter` | **未接入** | 无生产构造/提及 |
| `GeminiInteractionsAdapter` | **未接入** | 无生产构造/提及 |
| `AgentModelAssignmentController` | **未接入** | 无生产构造 |
| `BoundedProviderFallbackGuard` | **未接入** | 无生产构造 |
| `QuaternaryPermissionIntersectionGuard` | **未接入** | 无生产构造 |
| `TaskChainCumulativeBudgetController` | **未接入** | 无生产构造 |
| `SecondaryAgentSessionController` | **未接入** | 无生产构造 |
| `HumanWorktreeObserver` | **未接入** | 无生产构造 |
| `TertiaryAgentAssignmentPlanner` | **未接入** | 无生产构造 |
| `TertiarySingleChainExecutionGuard` | **未接入** | 无生产构造 |
| `ContinuationCoordinator` | **测试专用** | 仅测试构造；watchdog 组件无产品入口 |
| `FaultInjectionRecoveryVerifier` | **测试专用** | 仅测试构造 |

**分诊边界（如实）**：

- "被替代"基于"生产无构造 + 存在等价运行时实现"，未逐项比对行为差异；后继工作需核对等价性。
- "未接入"只说明当前无生产构造/入口，不等于应删除；后继按缺口清单排期。
- 本轮未对 24 项逐一读完整调用链（脚本信号 + 定向 grep）；"待核"保持原样。
