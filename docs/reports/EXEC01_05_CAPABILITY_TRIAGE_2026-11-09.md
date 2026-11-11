# EXEC-01-05：缺失能力分诊独立报告（2026-11-09）

- 核查基线：HEAD `aa415b1c`（2026-11-09 14:50 +0800，`feat(exec-01-04): wire execution into production…`）。
- 候选来源：`scripts/audit-product-reachability.mjs --json` 在当前 HEAD 的输出，`candidateCount = 21`。
  上一份报告 `AUDIT_REPAIR01_REACHABILITY_2026-11-06.md` §2/§6 列 24 项，其中 3 项
  （`AgentCommunicationDelegationController`、`DelegatedAgentCommunicationGrantStore`、
  `ToolDocumentationRecallController`）已由 EXEC-01-03/04 接线（`orchestration/main-controller.ts:974/1179/1180`），
  脚本不再产出 ⇒ 本报告只复核余下 21 项，**不沿用旧结论**。
- 路径约定：未注明者相对 `packages/core/src/`；`tests/…`、`docs/…`、`packages/tui/…` 相对仓库根。
- 判定口径严格按任务卡：注册=注册表/工厂/清单；分配=Agent/任务/工具子集；实际处理器=生产调用链会执行到；
  权限=能力映射/门禁；依赖装配=生产装配是否注入所需端口；应用正反例=是否用
  `createApplicationRuntime`/`ApplicationFacade`（`public-sdk.ts` 的 `AstarrayApplicationFacade`）。
- 复核手段：脚本信号 + 逐项读调用链 + `grep` 构造点/成员调用；旧报告标注"待核"的项一律重验。

## 1. 21 项逐条分诊

| 候选 | 定义位置 | 注册 | 分配 | 实际处理器 | 权限 | 依赖装配 | 应用正反例 | 分诊结论 |
|---|---|---|---|---|---|---|---|---|
| 1. `AzureOpenAiAdapter` | `runtime/azure-openai-adapter.ts:34` | 无（CLI 注册表只注册两项，`packages/tui/src/cli/runtime-selection.ts:125-129`；未见 Azure 注册器） | 无 | 无；协议接口仅声明+实现（`runtime/provider-protocol-port.ts:117`） | 不适用（出口扫描在运行时 `runtime/openai-compatible-runtime.ts:178`） | 无（未注册，无凭据/端点装配点） | 无，仅单测 `tests/core/unit/azure-bedrock-adapters.test.ts:34` | **未接入**：既定延后项，不是回归缺陷 |
| 2. `BedrockConverseAdapter` | `runtime/bedrock-converse-adapter.ts:122` | 无（同上；未见 Bedrock 注册器） | 无 | 无 | 不适用 | 无（无注册项；未找到签名端口装配） | 无，仅单测 `tests/core/unit/azure-bedrock-adapters.test.ts:86` | **未接入**：同上，延后项 |
| 3. `ContinuationCoordinator` | `orchestration/agent-run-watchdog.ts:148` | 无（`tests/core/unit/wiring-manifest.test.ts:53-109` 清单未列） | 无 | 无（`planContinuation` 零调用）；替代在 `orchestration/mission-orchestrator.ts:1570-1586` | 不适用 | 无：`saveCheckpoint` 端口未注入；替代实现只 `releaseTaskBackToPending`（`:1581`），**不落检查点** | 该类仅单测 `tests/core/unit/completion-protocol.test.ts:353`；替代实现有应用级正反例 `tests/core/integration/g5-early-stop-resume.test.ts:154,168` | **被替代**：续跑由编排器内联实现，但缺省关（`application-runtime.ts:3905` 仅在显式 true 时透传；门面默认 false，`public-sdk.ts:2797`） |
| 4. `FaultInjectionRecoveryVerifier` | `orchestration/fault-injection-recovery-verifier.ts:42` | 无 | 无 | 无 | 不适用 | 无（`classificationService`/`identityBudgetService` 仅测试注入，`:46`） | 无，仅单测 `tests/core/unit/fault-injection-recovery.test.ts:78` | **测试专用**：故障注入验证器，无产品语义入口 |
| 5. `LocalCompletionVerifier` | `orchestration/completion-verifier.ts:61` | 无 | 无 | 无；替代在 `orchestration/worker-agent.ts:298-330`（事件/任务 ID/产物） | 不适用 | 无（无构造）；替代实现不接收 `evidenceGate`/`hasUnresolvedLivelock`/`isTaskBudgetBypassed`（`:51-56`） | 该类仅单测 `tests/core/integration/completion-gate-counterexamples.test.ts:533`（同文件 A/B 段用真实门面，但对象是替代门禁） | **被替代**：替代只覆盖 8 条条件中的 3 条，证据包/活锁/预算条件仍无落点 |
| 6. `AgentModelAssignmentController` | `orchestration/agent-model-assignment-controller.ts:67` | 无（`packages/tui/src/cli/commands.ts:2558` 只做模块可加载，`:2580` 自述 not-assembly） | 无 | 无（`AGENT_MODEL_SWITCH_V1` 仅本文件）；替代 `public-sdk.ts:2633` 池 + `:2655-2660` 按 `agentInstanceId` 解绑定 | 不适用（切换无权限门禁） | 无：`sendSwitchEvent` 未注入（`:58`）；替代路径无安全检查点/固定锁定 | 无，仅单测 `tests/core/unit/agent-model-assignment.test.ts:19` | **被替代**：分配由绑定存储+运行时池承担，"仅安全点切换/切换事件"未实现 |
| 7. `AnthropicMessagesAdapter` | `runtime/anthropic-gemini-adapters.ts:31` | 无（运行时只复用其常量 `runtime/anthropic-messages-runtime.ts:35-38`；注册项见 `runtime/anthropic-messages-provider-registration.ts:14`） | 无 | 无；替代 `runtime/anthropic-messages-runtime.ts:98`（`:234` 起块累积） | 不适用（出口扫描 `:196`） | 不适用（运行时为注册实现） | 无，仅单测 `tests/core/unit/anthropic-gemini-adapters.test.ts:32` | **被替代**：协议由 `AnthropicMessagesRuntime` 直接实现 |
| 8. `BoundedProviderFallbackGuard` | `orchestration/bounded-provider-fallback-guard.ts:50` | 无（`commands.ts:2561/2578` 仅模块可加载） | 无 | 无（`guardFallbackAttempt` 零调用）；未见等价 fallback 链（`public-sdk.ts:2633` 池无切换预算） | 不适用；其出境策略端口（`:11`）未注入 | 无：缺必填 `dataEgressPolicyPort`（`:58`） | 无，仅单测 `tests/core/unit/bounded-provider-fallback.test.ts:22`；`tests/tui/unit/g9-status-report-honesty.test.ts:9` 只断言可加载 | **未接入**：有预算/退避语义，生产无构造也无等价实现 |
| 9. `GeminiInteractionsAdapter` | `runtime/anthropic-gemini-adapters.ts:189` | 无（协议可选值只有两个，`packages/tui/src/cli/runtime-selection.ts:24`） | 无 | 无 | 不适用 | 无（未注册） | 无，仅单测 `tests/core/unit/anthropic-gemini-adapters.test.ts:101` | **未接入**：协议未进产品目录（G7 同类延后） |
| 10. `GenericOpenAiCompatibleAdapter` | `runtime/openai-adapters.ts:265` | 无（其协议名 `:25` 无注册项） | 无 | 无；替代 `runtime/openai-compatible-runtime.ts:87` | 不适用（出口扫描 `:178`） | 不适用 | 无，仅单测 `tests/core/unit/openai-adapters.test.ts:161` | **被替代**：公共子集由 `OpenAiCompatibleRuntime` 实现 |
| 11. `OpenAiChatCompletionsAdapter` | `runtime/openai-adapters.ts:180` | 无 | 无 | 无（仅被 `runtime/azure-openai-adapter.ts:10` 继承，同样未构造） | 不适用 | 不适用 | 无，仅单测 `tests/core/unit/openai-adapters.test.ts:32` | **被替代**：生产用 `OpenAiCompatibleRuntime` |
| 12. `OpenAiResponsesAdapter` | `runtime/openai-adapters.ts:54` | 无（`openai-responses` 仅本文件 `:17` 与注释 `orchestration/provider-support-record.ts:39`） | 无 | 无；**无 Responses 运行时** | 不适用 | 无（未注册） | 无，仅单测 `tests/core/unit/openai-adapters.test.ts:27` | **未接入**：旧报告"被替代"不成立（生产无等价实现），属未接入 |
| 13. `QuaternaryPermissionIntersectionGuard` | `orchestration/quaternary-boundary-guards.ts:24` | 无（同文件 `:92` `QuaternaryGitBranchPolicy` 才被构造，`application-runtime.ts:1314`） | 无（四级创建 `orchestration/quaternary-lifecycle-controller.ts:51` 无生产调用方） | 无 | 求交逻辑本身是权限计算，但未接裁决链；生产权限止于三级 `tools/session-permission-elevation.ts:413` | 无：需三级有效决定/范围/期限（`:14-19`），无人提供 | 无，仅单测 `tests/core/unit/quaternary-lifecycle.test.ts:113` | **未接入**：四级权限求交与其创建入口都未接 |
| 14. `TaskChainCumulativeBudgetController` | `orchestration/task-chain-cumulative-budget.ts:37` | 无（`commands.ts:3115/3124` 只加载模块，`:3137` 未构造它） | 无 | 无；近义但不同维度的是 `application-runtime.ts:3340` `TaskCallBudgetLedger`（调用次数） | 不适用 | 无：需 `stateBaseDirectory`（`:24`）；检查点里该字段固定 0 并注明"尚未接入"（`application-runtime.ts:2912-2942`） | 无，仅单测 `tests/core/unit/task-chain-cumulative-budget.test.ts:28` | **未接入**：T07E-04 的文件/token 累计预算在生产不存在 |
| 15. `SecondaryAgentSessionController` | `tools/main-agent-readonly-projection.ts:62` | 无 | 无（文档要求由可信控制面调用：`docs/adr/0021-main-agent-readonly-and-session-permission-elevation.md:16`、`IMPLEMENTATION_PLAN.md:1006`） | 无；未找到等价入口 | 不适用（本身不是模型工具，`main-agent-readonly-projection.ts:12`） | 无：同文件 `MainAgentReadonlyToolProjection` 在 `application-runtime.ts:1108` 构造，本类未构造 | 无，仅单测 `tests/core/unit/projection-gaps.test.ts:11`、`tests/core/unit/session-permission-elevation.test.ts:100` | **未接入**：ADR 要求的次级会话控制面在产品中不存在 |
| 16. `HumanWorktreeObserver` | `orchestration/human-worktree-observer.ts:59` | 无（`commands.ts:2984` 仅模块可加载） | 无 | 无；**读端已装配**：`orchestration/recovery-reconciliation-ports.ts:114` 读 `<base>/human-change-journal`，`orchestration/recovery-center-controller.ts:152` 注入 | 不适用（只读观察） | 无：缺 `statusPort`/`fingerprintPort`/`journalBaseDirectory`（`:44-51`）；`Sha256FileFingerprinter` `:36` 无人注入；检查点 revision 固定 0（`application-runtime.ts:2936`） | 无，仅单测 `tests/core/unit/human-worktree-observer.test.ts:46` | **未接入**：读端有、写端从未构造 ⇒ 该 journal 生产恒空 |
| 17. `TertiaryAgentAssignmentPlanner` | `orchestration/tertiary-lifecycle.ts:47` | 无（同文件 `:146` 生命周期控制器被构造 `application-runtime.ts:146`，本类不在其中） | 无 | 无（`decideAssignment` 零调用） | 不适用 | 无（纯判定，无端口） | 无，仅单测 `tests/core/unit/agent-lifecycle-and-memory.test.ts:289` | **未接入**：三级"复用/新建"判定未接 |
| 18. `TertiarySingleChainExecutionGuard` | `orchestration/tertiary-lifecycle.ts:116` | 无 | 无 | 无（`bindActivation`/`assertTaskWithinChain` 零调用） | 相关但未接：禁用能力表 `:106` 无消费者 | 无（纯判定） | 无，仅单测 `tests/core/unit/agent-lifecycle-and-memory.test.ts:329` | **未接入**："一次激活一条链"的本地拒绝未生效 |
| 19. `MetricsRegistry` | `infra/metrics.ts:28` | 无 | 无 | 无；`orchestration/main-controller.ts:1196-1204` 的 `getMetricsSnapshot()` 恒返回 `null`（`public-sdk.ts:3080` 直透） | 不适用 | 无（未构造）；PERF/DIAG 走 `application-runtime.ts:3180` / `:3248` 的事件存储 | 无；测试把 `null` 固化为期望：`tests/core/unit/main-controller.test.ts:286`、`tests/core/unit/main-controller-facades.test.ts:168` | **未接入**：影响面仅 TUI 头栏（`DELIVERY_REPORT.md:83` 已如实记录） |
| 20. `AgentAddressGuard` | `orchestration/agent-parent-binding-store.ts:200` | 无（SDK 导出 `public-sdk.ts:118-124`） | 无（非工具） | 无；同等语义内联于调用点 `orchestration/collaboration-relay-via-parent.ts:80` | 不适用（只判"收件人是否已登记"，`:192-198`） | 无：需 `AgentCreationRegistry`；registry 已在 `application-runtime.ts:1161` 构造，但未注入本类 | 无，仅局部装配测试 `tests/core/integration/comm01-delivery-address-integrity.test.ts:146` 等 3 处 | **需宿主注入**：SDK 公开能力；生产投递路径已有内联等价校验 |
| 21. `TokenMeasurementService` | `measurement/token-measurement.ts:144` | 无（SDK 导出 `public-sdk.ts:829`） | 无 | 无；两个消费点均为"参数注入的辅助函数"（`measurement/provider-usage-capture.ts:87`、`measurement/request-budget.ts:227`），自身无调用方 | 不适用 | 无：需 tokenizer 适配器注册；`estimateTokensConservatively`（`:71`）无生产调用 | 无，仅局部装配测试 `tests/core/unit/token-measurement.test.ts:49` 等 4 处 | **需宿主注入**：SDK 公开计量服务，生产未用 ⇒ 请求预算/复算能力也未生效 |

## 2. 事实搜索：证据记录 ≠ 实际搜索

- **入口与权限存在**：`factVerification` 已注册（`tools/builtins.ts:287`），action 含 `search-sources`（`:301`）；
  能力映射 `network.read`（`tools/permission-capability-catalog.ts:120`，该项 assist 默认 `ask`、devolve `allow`，`:55`）；
  主 Agent 只读投影包含它（`tools/main-agent-readonly-projection.ts:26`），ponder 白名单不含它
  （`tools/local-tool-policy-engine.ts:21-27`）。
- **实际搜索不可达**：`search-sources` 要求 `executionContext.evidenceSearchAgent`（`tools/builtins.ts:1108`），
  缺失即抛"搜索代理未装配（离线）"（`:1110`）。该端口只有接口声明（`tools/evidence-search-agent-port.ts:25`）
  与装配选项位（`tools/policy-wrapper.ts:96`），装配层只注入证据包构建器
  （`application-runtime.ts:979` 构造、`:3115` 传入），`tools/policy-wrapper.ts:417` 仅做 `?? null`
  ⇒ **全仓无 `evidenceSearchAgent` 的生产赋值**。
- **证据记录可达**：`record-reasoning`（`:1174`）、`record-local-experiment`（`:1151`）、
  `build-evidence-bundle`（`:1191`，构建器已装配）都不依赖搜索代理 ⇒ 模型能"留证据"却不能"取得资料"。
- **无真实 Provider 装配**：仓库内没有任何搜索 Provider 实现；`EvidenceSearchAgentPort` 只在测试里以假实现注入
  （`tests/core/unit/evidence-verification.test.ts:451`），并有"null ⇒ 明确报未装配"的负例（同文件 `:485`）。
  证据包**内容**门禁 `EvidenceCompletionGate` 仍为零使用，接线清单标 `unreachableByDesign`
  （`tests/core/unit/wiring-manifest.test.ts:93-96`）。

## 3. 安装能力：检测/批准 ≠ 真正执行

- **检测/批准（模型工具路径）**：分类 → 两阶段门禁（已有资源询问 → 独立开关 → allow-once），
  实现 `tools/installation-gate-guard.ts:54`（流程 `:4-11`），装配 `application-runtime.ts:1031-1045`，
  注入策略包装 `:3151`，执行前判定并拒绝 `tools/policy-wrapper.ts:205-228`（抛错 `:226`）。
  交互端口 CLI 有真实实现 `packages/tui/src/cli/bootstrap.ts:28`（`InteractiveInstallationGatePort`）；
  SDK/GUI 未提供时 `installationUserPort = null` ⇒ fail-closed（`application-runtime.ts:1040`、
  `tools/installation-inquiry-registry.ts:9`）。
- **真正执行（安装动作）**：`ToolPackageZipInstaller.install`（`toolkit/tool-package-zip-installer.ts:236`，
  要求 `isConfirmed` `:240`，落库 `:284`），解压走受限环境子进程（`:161-183`）；SDK 暴露
  `public-sdk.ts:3545-3547`。
- **接线判定**：批准链**已接线**，但模型侧没有安装工具——内置工具表只有 12 个（`tools/builtins.ts:129/147/158/175/192/209/226/242/256/270/287/311`），
  唯一会被判为安装类的是进程执行，而它的后端在生产显式为 `null`、环境表为空
  （`application-runtime.ts:1081-1085`）⇒ **批准链存在但无模型可触发的安装动作**。
  真正的安装只能由宿主经 SDK 调 `installToolPackageZip` 并自报 `isConfirmed`，该路径**不经过**
  `InstallationGateGuard`。因此"安装已接通"的写法不成立。

## 4. 文件操作：复制 / 移动 / 重命名 / 删除

| 操作 | 产品入口 | 证据 |
|---|---|---|
| 复制 | **无模型工具** | 工具 action 只有 read/search/create/overwrite/process.*（`tools/tool-action-registry.ts:88-227`）；受控"跨项目副本"属 SDK/CLI 控制面：`orchestration/cross-project-authorization-store.ts:720`、`public-sdk.ts:6548/6568`、`packages/tui/src/cli/commands.ts:1094` |
| 移动 | **无** | 全仓未见移动实现（无 `move`/`rename` action）；同上 action 表 |
| 重命名 | **无工具，能力项先行** | `project.destructive-mutate` 描述含"删除、覆盖、替换、截断和重命名覆盖"（`tools/permission-capability-catalog.ts:52`），但工具映射表无任何工具挂到该能力（`:105-128`） |
| 删除 | **项目文件无入口**；仅备份删除 | `deleteBackup` 只删保管库备份（`tools/builtins.ts:226`，能力 `backup.delete` `:116`）；内部辅助 `infra/atomic-json.ts:240` `deleteFileIfExists`、`:228` `copyFileWithBackup` 仅供内部使用 |

结论：四项**全部缺模型可用入口**，缺的是任务范围与工具 action，不是底层能力；与卡内 §8
「若缺失采用文件工具族 action；逐项备份、版本冲突、授权，不借 Shell 绕过」一致。

## 结论与建议

1. **真实缺陷 4 项（需接线或降级声明）**：`SecondaryAgentSessionController`（ADR 要求，生产无入口）、
   `HumanWorktreeObserver`（读端已装配、写端从未构造 ⇒ 恢复中心的"人工变化"通道恒空）、
   `TaskChainCumulativeBudgetController`（T07E-04 的累计预算不存在，检查点里以 0 冒充）、
   `TertiaryAgentAssignmentPlanner` + `TertiarySingleChainExecutionGuard`（三级复用判定与单链拒绝都未接）。
2. **"被替代"但有语义缺口 2 项，应按差异而不是"已完成"处理**：`LocalCompletionVerifier`（替代实现
   `worker-agent.ts:298-330` 只做事件/任务/产物，证据包与活锁条件仍无落点）、`ContinuationCoordinator`
   （替代的早停续跑缺省关闭，且**不保存检查点**，与"从检查点续跑"的原文有距离）。
3. **协议适配器一组不应算缺陷**：`AnthropicMessagesAdapter`/`GenericOpenAiCompatibleAdapter`/
   `OpenAiChatCompletionsAdapter` 属**被替代**的死抽象（生产运行时已覆盖同类协议），
   `AzureOpenAiAdapter`/`BedrockConverseAdapter`/`GeminiInteractionsAdapter` 属**既定延后**（G7），
   只有 `OpenAiResponsesAdapter` 需更正旧结论：**生产无 Responses 实现 ⇒ 是未接入，不是被替代**。
4. **`测试专用` / `需宿主注入` 不计缺陷**：`FaultInjectionRecoveryVerifier` 是测试工具；
   `AgentAddressGuard`、`TokenMeasurementService` 是 SDK 公开能力，前者在生产投递路径已有内联等价校验，
   后者属"宿主不注入就没有计量"，应写成能力边界而不是漏洞。
5. **三个专项里最该先修的是"事实搜索"**：`search-sources` 在生产恒抛"搜索代理未装配"
   （`tools/builtins.ts:1110`），这是"看起来有事实核验、实际取不到资料"的唯一一处；安装与文件操作
   则分别是"批准链在、执行入口不在"和"底层设施在、工具 action 不在"，属范围问题。
6. **`MetricsRegistry` 记为已知限制而非高危项**（`main-controller.ts:1203` 恒 `null`，已有测试固化，
   影响面仅 TUI 头栏）；同理 `BoundedProviderFallbackGuard`、`QuaternaryPermissionIntersectionGuard`
   在"单 Provider + 无四级创建入口"的现状下不构成安全缺口，但必须先明确产品是否要支持这两条路径，
   否则应把对应能力从文档里降级，而不是让它们继续以"已有实现"出现在能力表里。

## 逐项定性（2026-11-11，按用户要求）

用户要求：**逐项对照原设计与任务卡**分类，不接受整批作为"待产品裁决"。
结果见 `docs/reports/EXEC01_05_CAPABILITY_CLASSIFICATION_2026-11-11.md`：

| 分类 | 数量 |
|---|---|
| **返修**（原范围接线缺口） | 9 |
| **替代**（不重复接线） | 4 |
| **未来**（既定延后，移出缺陷清单） | 3 |
| 子缺口（不重复接线，但条件/语义转返修） | 2 |

**本表未改代码**，仅定性；`替代`/`未来` 明确不接线。

## 返修进展（2026-11-11）：`HumanWorktreeObserver` 第 1 步

**问题**：`new HumanWorktreeObserver` 在全仓库 **0 处** ⇒ 写端从未构造，`human-change-journal` 生产恒空；
唯一生产引用是 CLI 的"模块可加载"探测（`typeof HumanWorktreeObserver === "function"`）。

**本轮补齐（自包含，不含接线）**：
`packages/core/src/orchestration/human-worktree-status-port.ts`
- `parseGitStatusPorcelainV1`：解析 `git status --porcelain=v1 -z`，
  **重命名/复制条目两个路径都算变更**（否则观察会漏旧路径）；
- `createHumanWorktreeStatusPort({ runGitCommand })`：**执行器由工具层注入**，核心层不 spawn 进程。

测试 4 条通过。**仍未完成**：把观察器在装配层构造（`stateDirectory` 的 `human-change-journal`）
并在人工改动检查点调用 `observeWorktree`；以及 `gitReadonlyView` 复用该端口的接线。

## 返修进展（第 30 轮）：接线前的一个**待决策点**

要构造 `HumanWorktreeObserver`，先得给它一个 `HumanWorktreeStatusPort`；
生产端口需要"执行 git 命令"的能力（上一轮已做成注入式）。

**目前的真实约束**：`application-runtime`（装配层）内部没有现成的 git 执行器；
它把 git 能力放在工具层（`gitReadonlyView` builtin 走工具端口）。

于是有两条路，**需要你选**（我不擅自选）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A | 装配层直接 `node:child_process` 跑 `git rev-parse/status` | 简单，但让核心装配层获得"起进程"能力，与既有分层（spawn 属工具/沙箱层）冲突 |
| B | 由工具层提供 git 执行器，再通过选项注入装配层 | 分层干净，但要新增一个端口并在 CLI/GUI 两处装配点都传 |

我倾向 **B**（与 `HumanWorktreeStatusPort` 的注入设计一致，也符合"核心不 spawn"）。

**本轮门禁**：`check:low-parallel` ⇒ **708 files / 4762 passed + 3 skipped，exit 0**（含上一轮的 status port）。

## 返修进展（第 31 轮）：`HumanWorktreeObserver` **写端已构造**

- **更正我上一轮的判断**：我曾写"核心层不 spawn 进程"——**不准确**。
  `orchestration/git-*`（如 `git-integration-coordinator`）本来就在核心层执行 git。
  因此新增默认执行器 `createDefaultGitCommandRunner`（`node:child_process`）**不破坏既有分层**，
  注入式签名继续保留（测试与替换用）。
- 装配层（`application-runtime`）现在**构造** `HumanWorktreeObserver`：
  `journalBaseDirectory = stateDirectory`、认证用户来源取 `authenticatedUserId`、
  status 端口用真实 git（`rev-parse` + `status --porcelain=v1 -z`）、指纹用 `Sha256FileFingerprinter`。
- 通过 `runtime.humanWorktreeObserver` 暴露。

**证据**（`tests/core/integration/human-worktree-observer-wiring.test.ts`）：
在临时 git 仓库制造一处改动 ⇒ 观察后 `changedPaths` 含 `a.txt` ⇒
`<stateDirectory>/human-change-journal/obs-1.json` **真的落盘**。

⇒ 分诊结论里"写端从未构造 ⇒ journal 恒空"这一点**已经改变**。

**仍未做**：生产流程里**主动触发**观察的检查点（目前是构造 + 可从装配入口调用，
尚无业务路径自动调用）；以及 `gitReadonlyView` 复用同一端口的接线。

## 返修进展（第 32 轮）：`HumanWorktreeObserver` **生产触发点已接**

- `AgentEditIntentGuard` 新增**可选** `worktreeObserver`：agent 记录"自写"前先观察一次人工工作树，
  标识为 `agent-write:<taskExecutionIdentifier>`；**未注入时行为完全不变**。
- 装配层把已构造的 `humanWorktreeObserver` 传进 guard ⇒ 生产路径上**真的会观察**。
- 观察失败**不阻塞写入**（观察是旁路证据，不是写入门禁）——有用例锁定。

**证据**（`tests/core/unit/human-worktree-observer-trigger.test.ts`，3 条）：
调用了观察器且标识带任务前缀；观察抛错时拒绝原因**不是** observe-boom；未注入时不因观察报错。

**仍未做**：`gitReadonlyView` 复用同一 status 端口；journal 的读取/展示入口（CLI）。

## 返修进展（第 33 轮）：journal **可被消费**

新增 `HumanWorktreeObserver.listObservationIdentifiers()`：列出 journal 已落盘的观察标识；
目录不存在 ⇒ 空数组（"还没观察"不是错误），其他读取失败 ⇒ 抛 `human-change-journal-unavailable`
（不伪装成"没有变化"）。

用例扩展为：观察后 `listObservationIdentifiers()` 含 `obs-1`，
且 `readHistoricalObservation("obs-1")` 能重放回同一份记录 ⇒ **写进去的证据能被读出来**，
不再是"写了没人看"。

**仍未做**：把该读取接到业务消费点（`gitReadonlyView` 展示或只读 CLI 子命令），
以及 `stale-write-guard` 是否应据此拒绝覆盖（属语义决策，需确认后再做）。
