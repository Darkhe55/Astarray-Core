/**
 * 主 Agent 控制器（T08）。
 * 职责：接收用户消息、维护模式与任务概要、Ponder 直接问答、
 * Assist 召唤次级调度后立即回到输入循环、Devolve 直接调度、
 * 权限询问转达用户并记录会话授权。
 */
import { createHash, randomUUID } from "node:crypto";
// G1 Step 3（2026-11-08 第 261 轮）：受控合并的五门禁评估（纯函数）。
import type { ToolPublicDocumentationRegistryEntry } from "../tools/tool-public-documentation-registry.js";
import type { ToolDocumentationRecallInjector } from "../tools/tool-documentation-recall.js";
import type { RunHistoryStore } from "./run-history-store.js";
import type { MissionRuntimeLease, MissionRuntimeRegistry } from "./mission-runtime-registry.js";
import type { ArtifactRecordStore } from "./artifact-record-store.js";
import { evaluateMergeReadinessWithProvider } from "./git-merge-readiness.js";
import type { GitMergeReadinessEvidence } from "./git-merge-readiness.js";

import { DomainError } from "../core/errors.js";
import { runToolLoop } from "../runtime/tool-loop.js";
import type { ToolLoopProgressGuardPort } from "../runtime/tool-loop.js";

import type {
  AgentMode,
  AgentRunInput,
  AgentRuntime,
  FeedbackTransportPort,
  TaskChainDocument,
  TaskDependencyNode,
  TaskStorePort,
  ToolDescriptor,
  ToolPort,
} from "../core/types.js";
import type { SessionAuthorizationManager } from "../core/permission-policy.js";
import { hashToolArguments } from "../core/permission-policy.js";
import type { ModeMachine } from "../core/mode-machine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkspaceBoundary } from "../tools/workspace-boundary.js";
import type { BackupDeletionAuthorizationController, BackupVault } from "../tools/backup-vault.js";
import type { AgentWorkArchiveStore } from "./work-archive-store.js";
import { AssistScheduler } from "./assist-scheduler.js";
import { DevolveScheduler } from "./devolve-scheduler.js";
import type { MissionManager } from "./mission-manager.js";
import type { MissionLeaseStore } from "../infra/mission-lease-store.js";
import type {
  GitIntegrationOrchestrationOptions,
  GitIntegrationPartialOptions,
  MissionDiagnosticEvent,
} from "./mission-orchestrator.js";
import type { ContextPromptProvider } from "./context-prompt-assembler.js";
import type { GuidanceControlQueue } from "../runtime-guidance/guidance-control-queue.js";
import type { ContextNodeLifecyclePort } from "./worker-agent.js";
import type { PermissionProfileStore } from "../tools/permission-profile-store.js";
import type { PermissionProfileReference } from "../tools/permission-profile-store.js";
import type { PermissionCapabilityCatalog } from "../tools/permission-capability-catalog.js";
import type { ConfigurablePermissionPolicyEngine } from "../tools/configurable-permission-policy-engine.js";
import type { ScopeAuthorizationGate } from "../tools/scope-authorization-gate.js";
import { describeToolOperation } from "../tools/scope-authorization-gate.js";
import type { RegisteredProjectRoot } from "../tools/scope-resolution.js";
import type { CurrentPermissionSelectionStore } from "../tools/current-permission-selection.js";
import type { MainAgentReadonlyToolProjection } from "../tools/main-agent-readonly-projection.js";
import type { SessionPermissionElevationStore } from "../tools/session-permission-elevation.js";
import type { SessionPermissionElevationController } from "../tools/session-permission-elevation.js";
import type { EffectiveSecondaryPermissionResolver } from "../tools/session-permission-elevation.js";
import type { SessionShutdownCoordinator } from "../tools/session-shutdown-and-export.js";
import type { CurrentPermissionConfigurationExporter } from "../tools/session-shutdown-and-export.js";
import type { RegisteredAgentDirectory } from "./registered-agent-directory.js";
import type { MainAgentReportArchiveIngestor } from "./main-agent-report-archive.js";
import { MainAgentReportReader } from "./main-agent-report-archive.js";
import type { TertiaryTerminalReport } from "./main-agent-report-archive.js";
import type { ConversationTaskInsertionController } from "./conversation-task-insertion-controller.js";
import type { ConversationIdentityStore } from "./conversation-identity-store.js";
import type { TaskSequenceManageController } from "./task-sequence-controllers.js";
import type { MissionRelationIndexStore } from "./mission-relation-index.js";
import { buildEvidenceSnapshot } from "./remote-evidence-snapshot.js";
import type {
  EvidenceSnapshot,
  EvidenceSnapshotCandidateEntry,
  EvidenceSnapshotRequest,
} from "./remote-evidence-snapshot.js";
import type { ContextRecallController } from "./context-recall-controller.js";
import type { ContextRecallResult } from "./context-recall-controller.js";
import type { ActorIdentity, TaskSequenceStatusController } from "./task-sequence-controllers.js";
import { TaskLedgerBridge } from "./task-ledger-bridge.js";
import type { TaskLedgerAlignmentReport } from "./task-ledger-bridge.js";
import { evaluateWorkWindowResume } from "./work-window-resume.js";
import type { WorkWindowResumeDecision } from "./work-window-resume.js";
import {
  buildSingleNodeDecomposition,
  parseAndValidateTaskDecomposition,
} from "./task-decomposition-contract.js";
import type { TaskDecompositionDraftProvider } from "./model-task-decomposition-planner.js";
import {
  decideTaskGroupInsertion,
  computeInsertionRequestFingerprint,
  parseRuntimeTaskInsertionRequest,
} from "./task-group-insertion-contract.js";
import type {
  RuntimeTaskInsertionRequest,
  TaskGroupInsertionOutcome,
} from "./task-group-insertion-contract.js";
import { IndependentReviewGate } from "./independent-review-gate.js";
import type {
  AppointIndependentReviewInput,
  RecordIndependentVerdictInput,
} from "./independent-review-gate.js";
import { MainAgentTaskProposalContract } from "./main-agent-proposal-contract.js";
import type { MainAgentTaskProposalSubmissionResult } from "./main-agent-proposal-contract.js";
import {
  MAIN_AGENT_TURN_BUDGET_MILLISECONDS,
  buildMainAgentTurnProgressRecord,
} from "./main-agent-turn-budget.js";
import type {
  MainAgentTurnOutcome,
  MainAgentTurnProgressRecord,
} from "./main-agent-turn-budget.js";
import type { TaskInsertionProposal } from "./conversation-task-insertion-controller.js";
import type { SecondaryContinuousDispatchLoop } from "./secondary-continuous-dispatch-loop.js";
import type { TertiaryAgentLifecycleController } from "./tertiary-lifecycle.js";
import type { AgentIndividualMemoryStore } from "./agent-individual-memory.js";
import type { CrossAgentContextAttachmentController } from "./cross-agent-attachment-controller.js";
import type { DirectDispatchController } from "./direct-dispatch-controller.js";
import type { SecondaryUserFacingSummaryController } from "./secondary-user-facing-summary-controller.js";
import type { ProjectReconnaissanceController } from "./project-reconnaissance-controller.js";
import type { AgentAppointmentRegistry } from "./agent-appointment-registry.js";
import type { AcceptanceVerdictGate } from "./acceptance-verdict-gate.js";
import type { QuaternaryLifecycleController } from "./quaternary-lifecycle-controller.js";

export interface MainControllerOptions {
  /**
   * EVENT-01（2026-10-24）：控制通道门禁（缺省 ⇒ 不门禁）。
   */
  workWindowGate?: (input: {
    missionId: string;
    taskIdentifier: string;
    gatePoint: "dispatch" | "model" | "tool-execution";
    toolName?: string;
  }) => Promise<
    | { readonly kind: "allow"; readonly reason: string }
    | {
        readonly kind: "deny";
        readonly reasonCode: string;
        readonly reason: string;
      }
  >;
  /** EVENT-01：事件源钩子（缺省 ⇒ 不产生事故）。 */
  eventSourceHooks?: {
    onToolFailed?(toolName: string, failureReason: string): void;
    onProviderFailure?(detail: string): void;
  };
  modeMachine: ModeMachine;
  sessionManager: SessionAuthorizationManager;
  taskStore: TaskStorePort;
  missionManager: MissionManager;
  registry: ToolRegistry;
  feedbackTransport: FeedbackTransportPort;
  workspaceBoundary: WorkspaceBoundary;
  /**
   * GUI-02-03（2026-11-08）：显式登记的工程根（与范围判定同源）。
   * 新建 mission 时用其**首个**条目的 `projectIdentifier` 记录"所属项目"，
   * 使历史视图能呈现卡内点名的"项目"字段。缺省则不写该字段（不臆造项目名）。
   */
  registeredProjectRoots?: RegisteredProjectRoot[];
  temporaryDirectoryPath: string;
  concurrency: number;
  failureThreshold: number;
  maxLoopIterations: number;
  /** T07D-R2-03：按任务工具子集解析暴露给 Provider 的工具描述符。 */
  resolveToolDescriptors?: (task: TaskDependencyNode) => ToolDescriptor[];
  /** T07D-R2-03：Provider 运行时强制要求本地完成控制事件。 */
  requireCompletionControlEvent?: boolean;
  /**
   * ALIGN-03-03（2026-10-28）：是否要求 **Worker 完成收据** 才判 `done`（缺省 false）。
   * 打开后：`success` 但收据缺失/矛盾 ⇒ 任务置 blocked 并升级，**不伪造 done**。
   */
  isCompletionReceiptRequired?: boolean;
  /** 显式对话模式（GUI 聊天）。 */
  isConversationMode?: boolean;
  /**
   * 产物对账的工作区根（2026-10-02）：与工具实际写入的工作区保持一致；
   * 缺省由装配方传入（通常 `options.workspaceRootPath ?? process.cwd()`）。
   */
  artifactWorkspaceRootPath?: string;
  /** T09A-R1-01：上下文提示词装配提供者。 */
  contextPromptProvider?: ContextPromptProvider;
  /** GUIDE-01-04：运行中指导控制队列（主 Agent 只读不变；指导由安全点消费）。 */
  guidanceControlQueue?: GuidanceControlQueue;
  /** T09A-R1-03：任务完成后的上下文节点收口。 */
  contextNodeLifecycle?: ContextNodeLifecyclePort | null;
  /** 次级/主 Agent 的 LLM 运行时工厂。 */
  mainRuntimeFactory: (agentInstanceId: string) => AgentRuntime;
  /** GUI-03 / 方案 A2：mission 预登记 runtime；缺省回退原工厂。 */
  missionRuntimeRegistry?: MissionRuntimeRegistry;
  artifactRecordStore?: ArtifactRecordStore;
  workWindowGateDecisionProvider?: (input: {
    missionId: string;
    projectIdentifier: string | null;
    nowIso: string;
  }) => Promise<{ isAllowed: boolean; reasonCode: string; reason: string }>;
  /** A2：mission 调度前解析模型 binding 并获取 lease；缺省不切换模型。 */
  missionRuntimePreparer?: (input: {
    missionId: string;
    projectIdentifier: string | null;
    sessionIdentifier: string | null;
    agentInstanceId: string | null;
  }) => Promise<MissionRuntimeLease | null>;
  workerRuntimeFactory: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  /**
   * T06B/ADR-0014：思索模式本地只读白名单工具（描述符 + 端口）。
   * 未装配时思索模式退化为纯问答、不暴露任何工具。
   */
  ponderReadonlyToolingFactory?: (agentInstanceId: string) => {
    toolDescriptors: ToolDescriptor[];
    toolPort: ToolPort;
  };
  /** Worker 工具端口工厂：按任务工具子集包装权限策略。 */
  buildWorkerToolPort: (
    task: TaskDependencyNode,
    allowedToolNames: Set<string>,
    /**
     * 具体 Agent 实例身份（2026-10-02 增加）。
     *
     * 缺省时回退为按 `task.id` 合成；**生产路径必须给出**，否则两个并行 mission 中
     * 同名的 `T-001` 会在读取抑制账本上共享键，导致第二个 Agent 的合法读取被判为
     * `resource-already-read`（u2-flash 真实实测缺陷）。
     */
    agentInstanceId?: string,
    /** 可选：该任务的执行根（GUI 多项目）；缺省用运行时默认工作区。 */
    workspaceRootPath?: string,
    /** 可选：该任务所属项目（读取文件夹授权扩展边界）。 */
    projectIdentifier?: string,
    missionIdentifier?: string,
  ) => ToolPort;
  /**
   * E2E-01-03 S2b：把**恢复检查点装饰器**套在 worker 工具端口**最外层**。
   *
   * 为什么在这里套：本闭包内已能拿到 `missionId`（见两处 `toolPortFactory` 调用点），
   * 而装饰器需要 mission 上下文；套在最外层才能把范围/权限门禁的拒绝也记成一次工具调用状态。
   * **未装配时行为完全不变**（不写检查点）。
   */
  buildRecoveryCheckpointingToolPort?: (input: {
    missionId: string;
    task: TaskDependencyNode;
    agentInstanceId: string;
    innerToolPort: ToolPort;
  }) => ToolPort;
  buildPermissionExplanation: (toolName: string) => string;
  /**
   * PERF-01-02 采集（2026-11-08，第 83 轮）：性能样本**落库端口**（可选）。
   *
   * **此前为何一直是缺口**：工具循环只声明了 `perfSampleSink`，而**应用装配从未接上**
   * ⇒ `PerfEventStore` 在生产里只被构造用于**查询**、`queryPerfOverview` 恒空。
   * 端口缺省 ⇒ 不采集（既有行为不变）。
   * 身份/任务由**编排层**补齐（它持有 `missionId` 与每任务的 `agentInstanceId`）。
   */
  perfSamplePort?: (sample: {
    sourceAgentInstanceId: string;
    missionIdentifier: string;
    taskIdentifier: string;
    operationKind: string;
    durationMilliseconds: number;
    outcome: "success" | "failure" | "cancelled" | "unknown";
  }) => Promise<void> | void;
  /**
   * DIAG-01 采集（2026-11-08，第 85 轮）：诊断失败事件落库端口（可选）。
   *
   * 与 `perfSamplePort` 同因：此前生产里**无人构造 `DiagnosticEvent`**，
   * store 只被构造用于查询 ⇒ `queryDiagnosticSummary` 恒"不可报告"。
   * **只在真实执行失败时被调用**（拒绝/取消在工具循环侧已被过滤）。缺省 ⇒ 不采集。
   */
  diagnosticEventPort?: (event: {
    sourceAgentInstanceId: string;
    missionIdentifier: string;
    taskIdentifier: string;
    errorCode: string;
    messageText: string;
    component: string;
    stage: "tool" | "provider";
    severity: "error";
  }) => Promise<void> | void;
  /**
   * DIAG-01 采集（2026-11-08，第 113 轮）：**使命级**诊断端口（可选，缺省 ⇒ 不采集）。
   *
   * 与上面的 `diagnosticEventPort` 的区别：上面那个是**个体/任务级**（工具与 Provider 失败，
   * 由工具循环上报、带 `taskIdentifier`）；本端口承接**使命级**失败
   * （如租约续约失败、Git 集成失败 —— 它们没有"某个任务"可归属，`taskIdentifier` 为 `null`）。
   *
   * `DiagnosticEvent.stage` 的联合类型里早有 `git`／`recovery`／`dispatch`／`config`，
   * 但**此前只有 `tool`／`provider` 有上报方**。缺省不提供 ⇒ 行为逐字不变。
   */
  missionDiagnosticEventPort?: (event: MissionDiagnosticEvent) => Promise<void> | void;
  /** G2（第 130 轮）：守卫端口（缺省 ⇒ 不传 ⇒ 不启用）。 */
  progressGuardPort?: ToolLoopProgressGuardPort;
  /** G3（第 133 轮）：高严谨性强制事实验证开关（缺省 ⇒ 不传 ⇒ 不启用）。 */
  /**
   * G5（2026-11-08 第 235 轮）：**早停 ⇒ 从检查点有界续跑**（缺省关）。
   * 仅当工具循环明确上报早停、且本任务续跑次数 < 2 时续跑。
   */
  isCheckpointResumeEnabled?: boolean;
  isHighRigorEnforcementEnabled?: boolean;
  /** 流式输出到 UI 的回调。 */
  streamOutput: (missionId: string | null, text: string) => void;
  /**
   * GUI-02-01 片①（2026-10-11）：权限询问**携带绝对身份**的上报口。
   *
   * 可选；未提供时行为与之前**逐字一致**（既有 `streamOutput` 路径不变）。
   * 两条调度路径（assist / devolve）在此汇合后转发给宿主。
   */
  onPermissionAskWithIdentity?: (input: {
    ownerAgentInstanceId: string;
    taskId: string;
    message: string;
  }) => void;
  /** 权限询问弹窗回调（Assist）。 */
  onPermissionAsk?: (ask: {
    missionId: string;
    taskId: string;
    toolName: string;
    argumentsJson: string;
    explanation: string;
  }) => void;
  onMissionFinished?: (missionId: string, status: "done" | "cancelled" | "blocked") => void;
  /** T06A：自动备份库（可选；缺省时破坏性工具拒绝执行）。 */
  backupVault?: BackupVault | null;
  backupDeletionController?: BackupDeletionAuthorizationController | null;
  /** T05A：Agent 工作存档（可选）。 */
  workArchiveStore?: AgentWorkArchiveStore | null;
  /** T05B → T08：Git 集成装配（可选；缺省时编排行为与旧版一致）。 */
  gitIntegration?: GitIntegrationPartialOptions | null;
  /** G4（第 281 轮）：工具公开用法登记（缺省 ⇒ 不注入）。 */
  toolDocumentationRegistry?: Record<string, ToolPublicDocumentationRegistryEntry>;
  /** G4（第 281 轮）：工具说明注入器（缺省 ⇒ 不注入）。 */
  toolDocumentationInjector?: ToolDocumentationRecallInjector;
  /** HISTORY-01-02（第 42 轮）：运行历史存储（缺省 ⇒ 不记录）。 */
  runHistoryStore?: RunHistoryStore | null;
  /**
   * G1 Step 3（2026-11-08 第 264 轮）：**合并证据提供者**（可选）。
   *
   * 缺省 ⇒ 空证据 ⇒ 恒不可合并（fail-closed）。
   * 前两门可由本地产生；**人工体验/操作授权只能由用户/平台提供的记录**填充 —— 不得伪造。
   */
  readMergeReadinessEvidence?: () => GitMergeReadinessEvidence;
  /** T05B：次级调度 Agent 具体实例 ID 工厂（每次 mission 不可复用）。 */
  secondaryAgentInstanceIdFactory?: (missionId: string) => string;
  /** B6R-04b：认证设置控制面依赖（TUI/CLI 共用；非模型工具）。 */
  permissionProfileStore?: PermissionProfileStore | null;
  permissionCapabilityCatalog?: PermissionCapabilityCatalog | null;
  currentPermissionSelectionStore?: CurrentPermissionSelectionStore | null;
  /** B6R-03/04b：当前权限组引用（可信运行时提供）。 */
  currentPermissionProfileReference?: PermissionProfileReference | null;
  /**
   * 修复（2026-10-01）：可配置权限引擎（生产次级 Agent 判定侧）。
   * 用户裁决授权必须**同时**写入该引擎，否则 `ask` 判定读不到授权，
   * 用户批准后重跑仍被要求逐次裁决（授权双轨失配）。
   */
  configurablePermissionPolicyEngine?: ConfigurablePermissionPolicyEngine | null;
  /**
   * 修复（2026-10-01）：作用域一次性授权门禁（`ScopeGatedToolPort` 使用的同一实例）。
   * 被权限询问拦下的那次尝试会消耗该操作指纹的授权，重跑须**重新登记**一次，
   * 否则重跑命中 `auth-scope-replay-rejected`，内层工具永不执行。
   */
  scopeAuthorizationGate?: ScopeAuthorizationGate | null;
  /** 已认证用户 ID（作用域授权记录 `approvedByUserId`；不得由模型/配置推断）。 */
  authenticatedUserId?: string | null;
  /** B6R-06：主 Agent 永久只读投影（任意 profile/提升下不变）。 */
  mainAgentReadonlyProjection?: MainAgentReadonlyToolProjection | null;
  /** B6R-06：会话临时提升控制面（TUI/CLI 认证设置控制面；非模型工具）。 */
  sessionElevationStore?: SessionPermissionElevationStore | null;
  sessionElevationController?: SessionPermissionElevationController | null;
  sessionElevationResolver?: EffectiveSecondaryPermissionResolver | null;
  sessionShutdownCoordinator?: SessionShutdownCoordinator | null;
  sessionExporter?: CurrentPermissionConfigurationExporter | null;
  /** B6R-09：Agent 注册目录（报告来源认证；不可复用身份）。 */
  registeredAgentDirectory?: RegisteredAgentDirectory | null;
  /** B6R-09：主 Agent 报告索引（只写不唤醒；来源认证）。 */
  reportArchiveIngestor?: MainAgentReportArchiveIngestor | null;
  /** B6R-09：对话任务插入控制面（主 Agent 提案；本地验证来源/优先级/锚点）。 */
  conversationTaskInsertionController?: ConversationTaskInsertionController | null;
  /**
   * ALIGN-01-01（2026-10-28）：**稳定会话 → 主个体 → 运行**的持久映射。
   *
   * 缺省 ⇒ 不启用（历史行为逐字不变，不落任何新文件）。启用后：
   * 每条用户消息仍新建 mission，但 mission 会归到**同一会话**的**同一主个体**；
   * 运行标识与 mission 标识分开登记。会话/个体标识由存储层生成，
   * **不由本控制器按 `mission-*` 或进程 ID 派生**。
   */
  conversationIdentityStore?: ConversationIdentityStore | null;
  /**
   * ALIGN-01-01：本进程可信的**主 Agent 个体标识**（装配层给出，如
   * `application-runtime` 的 state-dir 派生 id）。仅在启用
   * `conversationIdentityStore` 时作为该会话的主个体写入映射；缺省则由存储生成。
   */
  mainAgentInstanceId?: string;
  /**
   * ALIGN-01-05（2026-10-28）：主 Agent **单条处理预算**（缺省 180 秒）。
   *
   * 只作用于"主 Agent 自己跑模型"的路径（ponder）。耗尽即中止本轮、把已知进展
   * 落库并明确回报"待补信息/待继续"；**不得伪报已派发**。
   */
  mainAgentTurnBudgetMilliseconds?: number;
  /**
   * ALIGN-01-05：超期记录落库端口（缺省 ⇒ 仅保存在内存，不落盘）。
   * 观测/落盘失败不得阻塞对话，也不得掩盖超期这一事实。
   */
  mainAgentTurnProgressPort?: (
    record: MainAgentTurnProgressRecord,
  ) => Promise<void> | void;
  /**
   * ALIGN-02-01（2026-10-28）：**权威任务序列控制面**。
   *
   * 启用后：用户任务先登记进目标次级的版本化偏序集（序列不存在则发布），
   * 再创建 mission 作为"这一次任务组执行"的投影；mission 摘要记录
   * `taskSequenceIdentifier` / `originalTaskIdentifier` 映射。
   * 缺省 ⇒ 不登记（旧行为），但也就没有权威待办来源。
   */
  taskSequenceManageController?: TaskSequenceManageController | null;
  /**
   * ALIGN-04-01（2026-10-28）：**mission 关系索引**（显式关联的权威落盘）。
   *
   * 启用后：mission 创建时把 project/conversation/主个体/任务序列/任务包/参与个体
   * 写进 `<state>/mission-relations/<missionId>.json`；重启时由
   * `hydratePersistedMissionRelations()` 读回映射（**不按昵称/路径猜**）。
   * 缺省 ⇒ 只存在内存 Map（旧行为，重启即丢）。
   */
  missionRelationIndexStore?: MissionRelationIndexStore | null;
  /**
   * ALIGN-04-02（2026-10-28）：**恢复前只读对账门禁**（可选）。
   *
   * `resumeMission` 先调用它；返回 `isAllowedToResume:false` ⇒ 拒绝续接并如实给出原因
   * （状态损坏 / 尚未完成只读对账 / 租约被其他进程持有 …）。
   * 只做只读判定：**查看历史不启动任务**，恢复必须显式调用 `resumeMission`。
   */
  missionRecoveryGate?: (missionId: string) => Promise<{
    readonly isAllowedToResume: boolean;
    readonly blockedReasons: readonly string[];
  }>;
  /**
   * ALIGN-04-05（2026-10-28）：**按调用者构造的回访控制器**（节点关闭 → 回访重建）。
   *
   * 每个调用者（个体）有自己的回执冷却/预算账本，所以按 `callerAgentInstanceId` 构造；
   * 回访内容只来自该调用者可见的**关闭胶囊**，**不读全局摘要当完整历史**、
   * **不拼接全部角色日志**（由 `ContextRecallController` 的作用域与预算约束保证）。
   */
  contextRecallControllerFactory?: (
    callerAgentInstanceId: string,
  ) => ContextRecallController;
  /**
   * 接线缺口第 ① 项（2026-10-28）：只读序列状态控制面。
   *
   * 与 `taskSequenceManageController` **共享同一 store 实例**（同一份序列文件）；
   * 用于两套记账对照（`inspectTaskLedgerAlignment`），不改变任何状态。
   */
  taskSequenceStatusController?: TaskSequenceStatusController | null;
  /**
   * ALIGN-02-06（2026-10-28）：运行中插入的**安全点注入端口**（可选）。
   *
   * 实现方必须保证：只在安全上下文边界注入、不改写已发出的工具调用、
   * 不重复运行组内已完成任务。缺省 ⇒ 即使判定为 `insert-now` 也保守地
   * 保留到下一组（不硬塞），并在返回结果里说明原因。
   */
  taskGroupInsertionPort?: (input: {
    readonly missionIdentifier: string;
    readonly request: RuntimeTaskInsertionRequest;
    readonly groupIdentifier: string;
  }) => Promise<boolean>;
  /**
   * ALIGN-02-02（2026-10-28）：**分解候选稿**生产器（模型背书，可选）。
   *
   * 提供时：先用它拿到候选稿，再经本地契约校验（白名单/节点数/依赖环/验收要求/
   * 工具子集）后才写入任务链；校验失败 ⇒ **显式降级**为单节点并记录原因。
   * 缺省 ⇒ 保持单节点（旧行为），摘要里如实标 `legacy-single-node`。
   */
  taskDecompositionDraftProvider?: TaskDecompositionDraftProvider | null;
  /**
   * ALIGN-02-02：必要项目摘要提供者（可选；缺省 ⇒ 规划提示词明确"无摘要"）。
   * 只提供摘要，不提供整份项目内容 —— 规划不读源文件。
   */
  projectSummaryProvider?: (input: {
    readonly projectIdentifier: string | null;
    readonly conversationIdentifier: string | null;
  }) => Promise<string | null> | string | null;
  /** B6R-09：次级持续调度循环（生产装配；ready set 派发）。 */
  secondaryDispatchLoop?: SecondaryContinuousDispatchLoop | null;
  /** B6R-09：三级生命周期控制器（阶段持久化/幂等收口）。 */
  tertiaryLifecycleController?: TertiaryAgentLifecycleController | null;
  /** B6R-09：Worker 运行时组件（个体记忆/附件/生命周期；生产装配可达）。 */
  tertiaryRuntimeComponents?: {
    individualMemoryStore: AgentIndividualMemoryStore;
    attachmentController: CrossAgentContextAttachmentController;
    lifecycleController: TertiaryAgentLifecycleController;
  } | null;
  /** T08C-07：四层路由控制面（直投/摘要/侦察/任命裁决/四级；三入口共用）。 */
  t08cRoutingFacade?: T08cRoutingFacade | null;
  /** T12-02：跨进程 mission 活动租约（可选；透传给编排运行会话）。 */
  missionLeaseStore?: MissionLeaseStore | null;
  /** T12-02：本进程不可复用实例标识（装配租约时必填）。 */
  processInstanceId?: string;
}

/** T08C-07：四层路由控制面聚合（CLI/TUI/GUI 投递与状态视图共用）。 */
export interface T08cRoutingFacade {
  directDispatchController: DirectDispatchController;
  secondarySummaryController: SecondaryUserFacingSummaryController;
  reconnaissanceController: ProjectReconnaissanceController;
  appointmentRegistry: AgentAppointmentRegistry;
  acceptanceVerdictGate: AcceptanceVerdictGate;
  quaternaryLifecycleController: QuaternaryLifecycleController;
}

export class MainController {
  private readonly activeOrchestrators = new Map<
    string,
    { scheduler: AssistScheduler | DevolveScheduler; mode: AgentMode }
  >();

  /**
   * 任务级执行根（GUI 多项目）：missionId → workspaceRootPath。
   * 只影响该 mission 的工具边界；未登记则用运行时默认工作区。
   */
  private readonly missionWorkspaceRootPaths = new Map<string, string>();
  /** mission → 所属项目（文件夹授权按项目查询）。 */
  private readonly missionProjectIdentifiers = new Map<string, string>();
  private readonly missionSessionIdentifiers = new Map<string, string>();
  /** ALIGN-01-01：mission → 稳定会话（只在启用 `conversationIdentityStore` 时写入）。 */
  private readonly missionConversationIdentifiers = new Map<string, string>();
  /**
   * ALIGN-01-03：会话 → 最近一次**用户消息引用**。
   *
   * 主 Agent 的提案必须引用一次真实的用户任务；引用由 harness 在收到消息时生成，
   * 模型无法凭空发明（提案里的引用与这里不一致 ⇒ 拒绝）。
   */
  private readonly latestUserMessageReferences = new Map<string, string>();
  private readonly mainAgentProposalContract = new MainAgentTaskProposalContract();
  /** ALIGN-01-05：最近一次主 Agent 轮次的记账（只读给 UI；不含模型隐式状态）。 */
  private lastMainAgentTurnProgress: MainAgentTurnProgressRecord | null = null;
  /** ALIGN-02-01：mission → 权威任务序列/任务 投影映射。 */
  private readonly missionTaskSequences = new Map<
    string,
    {
      readonly taskSequenceIdentifier: string;
      readonly taskIdentifier: string;
      readonly ownerAgentInstanceIdentifier: string;
      sequenceRevision: number;
      readonly isSequenceCreated: boolean;
    }
  >();
  /** ALIGN-02-06：插入请求幂等键 → 内容指纹（进程内；重启后按序列任务 id 幂等）。 */
  private readonly insertionRequestFingerprints = new Map<string, string>();
  /** ALIGN-03-01：独立审查门禁（惰性装配；缺四层路由控制面时拒绝）。 */
  private independentReviewGateInstance: IndependentReviewGate | null = null;
  /** REMOTE-01-01：每个 requestIdentifier 的快照 revision 计数（进程内；持久化属 01-02）。 */
  private readonly evidenceSnapshotRevisions = new Map<string, number>();
  /** 任务级目标 Agent（GUI 投递目标）：作为该 mission 工具调用主体。 */
  private readonly missionTargetAgentIdentifiers = new Map<string, string>();

  /** GUI-03-02：按 mission 解析所属项目（只读；未知返回 null）。 */
  getMissionProjectIdentifier(missionId: string): string | null {
    return this.missionProjectIdentifiers.get(missionId) ?? null;
  }

  /** ALIGN-01-01：按 mission 解析其稳定会话（只读；未启用或未知返回 null）。 */
  getMissionConversationIdentifier(missionId: string): string | null {
    return this.missionConversationIdentifiers.get(missionId) ?? null;
  }

  /** ALIGN-01-05：最近一次主 Agent 轮次记账（只读；未知返回 null）。 */
  getLastMainAgentTurnProgress(): MainAgentTurnProgressRecord | null {
    return this.lastMainAgentTurnProgress;
  }

  /** ALIGN-02-01：mission → 权威任务序列/任务 的投影映射（只读；未登记返回 null）。 */
  getMissionTaskSequence(missionId: string): {
    readonly taskSequenceIdentifier: string;
    readonly taskIdentifier: string;
    readonly ownerAgentInstanceIdentifier: string;
    readonly sequenceRevision: number;
    readonly isSequenceCreated: boolean;
  } | null {
    return this.missionTaskSequences.get(missionId) ?? null;
  }

  constructor(private readonly options: MainControllerOptions) {}

  /** 模式切换（TUI 调用）：交由状态机校验，非法迁移抛 DomainError。 */
  transitionMode(nextMode: AgentMode): void {
    this.options.modeMachine.transition(nextMode, "user-request");
  }

  getCurrentMode(): AgentMode {
    return this.options.modeMachine.getCurrentMode();
  }

  /** 指标快照（TUI 头栏使用）；未配置指标时返回 null。 */
  getMetricsSnapshot(): {
    toolCalls: number;
    providerCalls: number;
    estimatedTokenCount: number;
    cacheHits: number;
    cacheMisses: number;
  } | null {
    return null;
  }

  /**
   * 处理用户消息。Ponder 直接问答；Assist/Devolve 创建/接管 mission
   * 后立即返回（不阻塞输入循环）。
   */
  async handleUserMessage(
    message: string,
    options?: {
      readonly projectIdentifier?: string;
      /** 可选：本任务的执行根（GUI 多项目），只在该根内执行工具。 */
      readonly workspaceRootPath?: string;
      /** 可选：指定执行该任务的 Agent 实例。 */
      readonly targetAgentInstanceIdentifier?: string;
      readonly sessionIdentifier?: string;
      /**
       * ALIGN-01-01：显式指定的**稳定会话**标识。
       *
       * 缺省 ⇒ 复用该项目最近活跃会话（首次则开新会话）。绝不按
       * `missionId` / 进程 ID / 角色名推导会话身份。
       */
      readonly conversationIdentifier?: string;
    },
  ): Promise<string> {
    /**
     * ALIGN-01-02：**项目归属在被任何模式消费之前解析**。
     *
     * ponder 也要绑定会话与个体（否则每次追问都换一个"主个体"，记忆无处归属），
     * 所以这里不能像之前那样只服务于 mission 分支。
     */
    const requestedProjectIdentifier = options?.projectIdentifier?.trim();
    const projectIdentifier =
      requestedProjectIdentifier !== undefined && requestedProjectIdentifier !== ""
        ? requestedProjectIdentifier
        : this.options.registeredProjectRoots?.[0]?.projectIdentifier;
    const mode = this.options.modeMachine.getCurrentMode();
    if (mode === "ponder") {
      await this.respondInPonderMode(message, {
        projectIdentifier,
        ...(options?.conversationIdentifier === undefined
          ? {}
          : { requestedConversationIdentifier: options.conversationIdentifier }),
      });
      return "ponder";
    }
    const missionId = `mission-${randomUUID().slice(0, 8)}`;
    const requestedTargetAgentInstanceIdentifier =
      options?.targetAgentInstanceIdentifier?.trim();
    /**
     * ALIGN-01-01：**先解析会话身份，再落 mission**。
     *
     * 会话/个体标识是权威持久映射；mission 只是本次执行投影。解析失败
     * （会话已关闭、同 id 异项目/异个体）**直接失败**，不静默改绑、不自动
     * 换一个新会话把问题藏起来。
     */
    const conversationIdentity =
      await this.resolveConversationIdentityForMission(projectIdentifier, {
        requestedConversationIdentifier: options?.conversationIdentifier,
      });
    const workWindowDecision = await this.options.workWindowGateDecisionProvider?.({
      missionId,
      projectIdentifier: projectIdentifier ?? null,
      nowIso: new Date().toISOString(),
    });
    if (workWindowDecision !== undefined && !workWindowDecision.isAllowed) {
      throw new DomainError("work-window-resting", workWindowDecision.reason);
    }
    /**
     * ALIGN-02-02（2026-10-28）：默认执行**不再固定 T-001**。
     *
     * 有候选稿生产器 ⇒ 规划 → 本地校验 → 采用；校验/规划失败 ⇒ 显式降级为单节点
     * 并记录原因（用户可见 + 摘要可查）。没有生产器 ⇒ 旧行为，但摘要标
     * `legacy-single-node`，不把它说成"已规划"。
     */
    const taskPlanning = await this.planTaskDecomposition({
      missionId,
      instructionText: message,
      projectIdentifier: projectIdentifier ?? null,
      conversationIdentifier: conversationIdentity?.conversationIdentifier ?? null,
    });
    const taskNodes = taskPlanning.nodes;
    /**
     * ALIGN-02-01（2026-10-28）：**先把用户任务登记进权威偏序集，再建 mission 投影**。
     *
     * 顺序不可颠倒：序列是权威待办，mission 只是"这一次任务组执行"的投影。
     * 登记失败（例如序列竞态）⇒ 抛出，**不**留下一个没有权威来源的 mission。
     *
     * 只对 **assist** 登记：devolve 由主 Agent 直接调度、没有下级偏序集，
     * 给它编一条"次级序列"就是把调度方式记错（等 ALIGN-02 统一后再迁移）。
     */
    const userTaskSequence =
      mode === "assist"
        ? await this.registerUserTaskInSequence({
            missionId,
            instructionText: message,
            secondaryAgentInstanceId:
              this.resolveSecondaryAgentInstanceIdentifier(missionId),
          })
        : null;
    await this.options.missionManager.createMission({
      missionId,
      mode,
      prompt: message,
      taskNodes,
      ...(projectIdentifier === undefined ? {} : { projectIdentifier }),
      ...(conversationIdentity === null
        ? {}
        : { conversationIdentifier: conversationIdentity.conversationIdentifier }),
      ...(userTaskSequence === null
        ? {}
        : {
            taskSequenceIdentifier: userTaskSequence.taskSequenceIdentifier,
            originalTaskIdentifier: userTaskSequence.taskIdentifier,
          }),
      taskPlanningOutcome: taskPlanning.outcome,
      ...(taskPlanning.fallbackReason === null
        ? {}
        : { taskPlanningFallbackReason: taskPlanning.fallbackReason }),
    });
    /**
     * ALIGN-01-01：把本次执行登记成该会话下的一次**运行**。
     *
     * 顺序刻意放在 mission 落盘之后：运行记录指向已存在的 mission（不会出现
     * "运行指向一个没建成的 mission"）。登记失败即抛出 —— 调用方看到失败，
     * 不静默留下"有 mission 没身份"的孤儿。
     */
    if (conversationIdentity !== null) {
      const userMessageReference = this.rememberUserMessageReference(
        conversationIdentity.conversationIdentifier,
      );
      await this.options.conversationIdentityStore?.beginRun({
        conversationIdentifier: conversationIdentity.conversationIdentifier,
        ...(requestedTargetAgentInstanceIdentifier === undefined
          ? {}
          : { agentInstanceIdentifier: requestedTargetAgentInstanceIdentifier }),
        missionIdentifier: missionId,
        userMessageReference,
      });
      this.missionConversationIdentifiers.set(
        missionId,
        conversationIdentity.conversationIdentifier,
      );
    } else {
      /**
       * 没有会话映射（未启用或没有项目）时也要生成引用：提案通道不能因为
       * 身份存储被关掉就允许"无来源提案"。引用只存在本进程内，重启即失效 ——
       * 这比伪造一个持久引用更诚实。
       */
      this.rememberUserMessageReference(null);
    }
    /**
     * ALIGN-04-01（2026-10-28）：把本次执行的**显式关联**落盘。
     *
     * 写失败不静默：通过流式输出如实告知（mission 已在运行，不能因索引失败回退），
     * 重启时该 mission 会缺映射 —— 但不会被"猜"出来。
     */
    await this.recordMissionRelation({
      missionId,
      projectIdentifier,
      conversationIdentity,
      userTaskSequence,
      targetAgentInstanceIdentifier: requestedTargetAgentInstanceIdentifier,
      mode,
    });
    const requestedWorkspaceRootPath = options?.workspaceRootPath?.trim();
    if (
      requestedWorkspaceRootPath !== undefined &&
      requestedWorkspaceRootPath !== ""
    ) {
      this.missionWorkspaceRootPaths.set(missionId, requestedWorkspaceRootPath);
    }
    if (projectIdentifier !== undefined) {
      this.missionProjectIdentifiers.set(missionId, projectIdentifier);
    }
    if (options?.sessionIdentifier !== undefined && options.sessionIdentifier.trim() !== "") {
      this.missionSessionIdentifiers.set(missionId, options.sessionIdentifier);
    }
    if (
      requestedTargetAgentInstanceIdentifier !== undefined &&
      requestedTargetAgentInstanceIdentifier !== ""
    ) {
      this.missionTargetAgentIdentifiers.set(
        missionId,
        requestedTargetAgentInstanceIdentifier,
      );
    }
    const preparedLease = await this.options.missionRuntimePreparer?.({
      missionId,
      projectIdentifier: projectIdentifier ?? null,
      sessionIdentifier: options?.sessionIdentifier ?? null,
      agentInstanceId: requestedTargetAgentInstanceIdentifier ?? null,
    });
    if (preparedLease !== null && preparedLease !== undefined) {
      this.options.missionRuntimeRegistry?.register(preparedLease);
    }
    if (mode === "assist") {
      this.launchAssistMission(missionId, taskNodes);
    } else {
      this.launchDevolveMission(missionId, taskNodes);
    }
    /**
     * ALIGN-02-07（2026-10-28）：新任务进入可执行集合 ⇒ **事件唤醒**调度，
     * 而不是让调度方按固定周期忙轮询。
     */
    this.options.secondaryDispatchLoop?.notifySchedulingEvent("task-ready");
    return missionId;
  }

  /**
   * T12A-R1-04：真正续接既有 mission（不新建 mission、不复用旧身份）。
   * 读取持久化任务链中的未完成任务，按原 mode 重新调度；无未完成任务则幂等返回。
   */
  async resumeMission(missionId: string): Promise<void> {
    /**
     * ALIGN-04-04（2026-10-28）：同一 mission 已有活动调度器 ⇒ **幂等跳过**。
     *
     * 工作时段恢复/重复唤醒/timer 抖动都可能重复调用本方法；同进程内重复调度
     * 会让同一任务跑两遍（重复副作用）。这里以"是否有活动编排器"为准，不再启动第二个。
     */
    if (this.activeOrchestrators.has(missionId)) {
      return;
    }
    /**
     * ALIGN-04-02（2026-10-28）：**恢复前先过只读对账门禁**。
     *
     * 状态损坏 / 尚未完成只读对账 / 租约冲突时**不续接**，把原因如实抛出；
     * 绝不因为"历史里有这条 mission"就自动启动任务。
     */
    const recoveryGate = this.options.missionRecoveryGate;
    if (recoveryGate !== undefined) {
      const recoveryDecision = await recoveryGate(missionId);
      if (!recoveryDecision.isAllowedToResume) {
        throw new DomainError(
          "mission-locked",
          `恢复被拒（先完成只读对账/解除阻塞再续接）: ${recoveryDecision.blockedReasons.join("；")}`,
        );
      }
    }
    const missionStatus =
      await this.options.missionManager.getMissionStatus(missionId);
    if (missionStatus.taskChain === null) {
      throw new DomainError("mission-not-found", `任务不存在: ${missionId}`);
    }
    /**
     * ALIGN-04-03（2026-10-28）：**未完成 ≠ 可以自动重跑**。
     *
     * 运行中（崩溃时在途，副作用未知）、阻塞（等待裁决）、已产出未回执这三类任务
     * 必须先对账/裁决；存在任何一类就**拒绝自动恢复**并列出具体任务。
     */
    const resumeReadiness = this.projectMissionResumeReadiness(missionStatus.taskChain);
    if (!resumeReadiness.isAutoResumable) {
      throw new DomainError(
        "mission-locked",
        `不自动恢复（需先对账/裁决）: ${resumeReadiness.blockedReasons.join("；")}`,
      );
    }
    /**
     * ALIGN-04-03：**恢复租约幂等领取**。过期租约按 revision 乐观接管；
     * 别的进程仍持活动租约 ⇒ 拒绝接管（不抢正在跑的 mission）。
     */
    await this.prepareResumeLease(missionId);
    const resumeWorkWindowDecision = await this.options.workWindowGateDecisionProvider?.({
      missionId,
      projectIdentifier: this.missionProjectIdentifiers.get(missionId) ?? null,
      nowIso: new Date().toISOString(),
    });
    if (resumeWorkWindowDecision !== undefined && !resumeWorkWindowDecision.isAllowed) {
      throw new DomainError("work-window-resting", resumeWorkWindowDecision.reason);
    }
    const incompleteTasks = missionStatus.taskChain.tasks.filter(
      (task) => task.status !== "done",
    );
    if (incompleteTasks.length === 0) {
      return;
    }
    const mode =
      missionStatus.summary?.mode ?? this.options.modeMachine.getCurrentMode();
    if (mode === "ponder") {
      throw new DomainError(
        "invalid-mode-transition",
        `Ponder 模式不产生 mission 续接: ${missionId}`,
      );
    }
    await this.options.missionManager.updateMissionStatus(missionId, "running");
    const preparedLease = await this.options.missionRuntimePreparer?.({
      missionId,
      projectIdentifier: this.missionProjectIdentifiers.get(missionId) ?? null,
      sessionIdentifier: this.missionSessionIdentifiers.get(missionId) ?? null,
      agentInstanceId: this.missionTargetAgentIdentifiers.get(missionId) ?? null,
    });
    if (preparedLease !== null && preparedLease !== undefined) {
      this.options.missionRuntimeRegistry?.register(preparedLease);
    }
    if (mode === "devolve") {
      this.launchDevolveMission(missionId, incompleteTasks);
    } else {
      this.launchAssistMission(missionId, incompleteTasks);
    }
  }

  /** 用户裁决：允许（含会话级）或拒绝权限请求。 */
  async grantSessionAuthorization(
    toolName: string,
    argumentsJson: string,
    nowUnixSeconds: number,
  ): Promise<void> {
    this.options.sessionManager.grant(
      toolName,
      hashToolArguments(argumentsJson),
      nowUnixSeconds,
    );
    // 修复（2026-10-01）：生产次级 Agent 路径由 ConfigurablePermissionPolicyEngine 判定
    // `ask`，该引擎只读自己的授权表；若只写旧 sessionManager，用户批准后重跑仍会被要求
    // 逐次裁决（授权双轨失配）。此处同时写入引擎，绑定当前 profile revision。
    const configurableEngine = this.options.configurablePermissionPolicyEngine;
    const profileReference = await this.getCurrentPermissionProfileReference();
    if (
      configurableEngine !== null &&
      configurableEngine !== undefined &&
      profileReference !== null
    ) {
      await configurableEngine.grantSessionAuthorization({
        toolName,
        profileReference,
        argumentsJson,
      });
    }
  }

  /**
   * 用户 `allow-once` 后**重新登记**一次作用域授权（修复 2026-10-01）。
   *
   * 背景：被权限询问拦下的那次尝试会让 `ScopeAuthorizationGate` 记下并消费该操作指纹
   * 的授权，重跑即命中 `auth-scope-replay-rejected`（内层工具从不执行）。
   * 重跑对用户而言是同一逻辑操作的**首次真实执行**，因此在授权时重新登记一次；
   * 重放保护本身不变（同一指纹第二次重放仍被拒）。
   */
  async grantScopeAuthorizationForToolCall(input: {
    toolName: string;
    argumentsJson: string;
  }): Promise<{ receiptIdentifier: string; operationFingerprint: string } | null> {
    const scopeGate = this.options.scopeAuthorizationGate;
    if (scopeGate === null || scopeGate === undefined) {
      return null;
    }
    const operation = describeToolOperation(input.toolName, input.argumentsJson);
    if (operation === null) {
      return null; // 该工具不受范围门禁约束
    }
    const approvedByUserId = this.options.authenticatedUserId;
    if (approvedByUserId === null || approvedByUserId === undefined || approvedByUserId === "") {
      // 无认证身份不得登记"用户已授权"记录：退回需人工裁决（复用既有稳定错误码）。
      throw new DomainError(
        "permission-ask-pending",
        "缺少可信认证身份，无法登记作用域授权（需人工裁决）",
      );
    }
    // 新契约（2026-10-02）：授权绑定**逻辑操作 ID + 完整规范化参数**，不只绑定范围指纹；
    // 同路径内容变化必须重新裁决，键序等价的参数视为同一逻辑操作。
    return scopeGate.grantUserAuthorization({
      operation,
      approvedByUserId,
      argumentsJson: input.argumentsJson,
    });
  }

  async queryMissionStatus(missionId: string) {
    return this.options.missionManager.getMissionStatus(missionId);
  }

  /**
   * 应用关闭：取消全部在途编排并等待调度器与 Worker 收敛，
   * 避免关闭后仍有后台状态写入（T07D-R1-03）。
   */
  async shutdown(): Promise<void> {
    const activeEntries = [...this.activeOrchestrators.values()];
    this.activeOrchestrators.clear();
    await Promise.allSettled(
      activeEntries.map((entry) => entry.scheduler.cancel()),
    );
  }

  async cancelMission(missionId: string): Promise<void> {
    const active = this.activeOrchestrators.get(missionId);
    if (active !== undefined) {
      await active.scheduler.cancel();
    }
    await this.options.missionManager.updateMissionStatus(missionId, "cancelled");
  }

  getActiveMissionIds(): string[] {
    return [...this.activeOrchestrators.keys()];
  }

  // ─── B6R-04b：认证设置控制面（只读查询 + 切换；非模型工具） ───────────

  /** 当前权限组引用（优先选择存储；否则运行时注入的默认）。 */
  async getCurrentPermissionProfileReference(): Promise<PermissionProfileReference | null> {
    const selectionStore = this.options.currentPermissionSelectionStore;
    if (selectionStore !== null && selectionStore !== undefined) {
      const selection = await selectionStore.readSelection();
      if (selection !== null) {
        return selection.selectedReference;
      }
    }
    return this.options.currentPermissionProfileReference ?? null;
  }

  /** 权限组公开列表（内置三组 + 自定义组；分页）。 */
  async listPermissionProfiles(input: { page: number; pageSize: number }) {
    const profileStore = this.options.permissionProfileStore;
    if (profileStore === null || profileStore === undefined) {
      return { profiles: [], total: 0, page: input.page, pageSize: input.pageSize };
    }
    const builtinProfiles = ["ponder", "assist", "devolve"].map((profileId) =>
      profileStore.buildBuiltinProfile(profileId as "ponder" | "assist" | "devolve"),
    );
    const customProfiles = await profileStore.listCustomProfiles();
    const allProfiles = [...builtinProfiles, ...customProfiles];
    const page = Math.max(1, input.page);
    const pageSize = Math.max(1, input.pageSize);
    const pageItems = allProfiles.slice((page - 1) * pageSize, page * pageSize);
    return {
      profiles: pageItems.map((profile) => ({
        permissionProfileId: profile.permissionProfileId,
        displayName: profile.displayName,
        isBuiltin: profile.isBuiltin,
        revision: profile.revision,
      })),
      total: allProfiles.length,
      page,
      pageSize,
    };
  }

  /** 认证用户切换当前权限组（持久化；写入自动备份）。 */
  async switchPermissionProfile(reference: PermissionProfileReference): Promise<void> {
    try {
      const selectionStore = this.options.currentPermissionSelectionStore;
      if (selectionStore === null || selectionStore === undefined) {
        throw new Error("当前权限组选择存储未装配");
      }
      // 自定义组必须先证明存在，避免持久化悬空引用（内置组恒存在，不依赖该存储）。
      if (reference.kind === "custom") {
        const profileStore = this.options.permissionProfileStore;
        if (profileStore === null || profileStore === undefined) {
          throw new Error("权限组存储未装配");
        }
        await profileStore.readProfile(reference);
      }
      const current = await selectionStore.readSelection();
      await selectionStore.switchSelection({
        selectedReference: reference,
        expectedRevision: current?.revision ?? 0,
      });
    } catch (error) {
      /**
       * DIAG-01（2026-11-08，第 115 轮）：**配置类失败**此前对诊断完全不可见 ——
       * 用户切换权限组失败（自定义组不存在、存储未装配、revision 冲突）只把错误抛回调用方，
       * 事后没人能从诊断里回答"为什么切不过去" ⇒ 按 `stage: "config"` 上报。
       *
       * 纪律：**只加观测**（下面**原样重抛**同一个错误 ⇒ 调用方看到的行为逐字不变）、
       * 观测自身失败**不得掩盖**原错误（独立 try/catch）、缺省不采集。
       */
      await this.reportConfigDiagnosticEvent({
        errorCode: error instanceof DomainError ? error.errorCode : null,
        fallbackErrorCode: "permission-profile-switch-failed",
        component: "permission-profile",
        error,
      });
      throw error;
    }
  }

  /** DIAG-01（第 115 轮）：`stage: "config"` 的统一上报入口（使命级端口；缺省不采集）。 */
  private async reportConfigDiagnosticEvent(input: {
    errorCode: string | null;
    fallbackErrorCode: string;
    component: string;
    error: unknown;
  }): Promise<void> {
    const missionDiagnosticEventPort = this.options.missionDiagnosticEventPort;
    if (missionDiagnosticEventPort === undefined) {
      return;
    }
    try {
      await missionDiagnosticEventPort({
        /** 切换权限组是**会话级**操作、与具体使命无关 ⇒ 如实传 `null`（不编造身份）。 */
        missionIdentifier: null,
        sourceAgentInstanceId: "main-controller",
        stage: "config",
        errorCode: input.errorCode ?? input.fallbackErrorCode,
        messageText: (input.error as Error).message,
        component: input.component,
      });
    } catch {
      // 观测失败不得阻塞业务，也不得掩盖原错误
    }
  }

  // ─── B6R-06：主 Agent 永久只读 + 会话提升控制面 ───────────────────────

  /** 主 Agent 可用工具名（任意 profile/提升下恒为只读白名单）。 */
  getMainAgentToolProjection(): string[] {
    const projection = this.options.mainAgentReadonlyProjection;
    if (projection === null || projection === undefined) {
      return [];
    }
    return projection.projectTools(
      this.options.registry.getPreviewDescriptors().map((descriptor) => descriptor.name),
    );
  }

  /**
   * ALIGN-01-03：**主 Agent 提交任务提案的本地入口**（不是模型可调用的工具）。
   *
   * 分工：
   * - 模型只产出"做什么"的结构化 JSON；
   * - 来源（恒 `agent`）、来源个体、认证用户、用户任务引用**全部由 harness 注入**；
   * - revision/锚点/优先级仍由既有 `ConversationTaskInsertionController` 判定。
   *
   * 失败一律抛出，不返回"看起来成功"的空结果（模型不得把自己的提案当成已分发）。
   */
  async submitMainAgentTaskProposal(
    payload: unknown,
    options?: { readonly conversationIdentifier?: string },
  ): Promise<MainAgentTaskProposalSubmissionResult> {
    const insertionController = this.options.conversationTaskInsertionController;
    if (insertionController === null || insertionController === undefined) {
      throw new DomainError(
        "invalid-task-chain",
        "本地提案控制面未装配：主 Agent 提案无法提交（不得假装已登记）。",
      );
    }
    const requestedConversationIdentifier = options?.conversationIdentifier?.trim();
    const conversationIdentifier =
      requestedConversationIdentifier !== undefined &&
      requestedConversationIdentifier !== ""
        ? requestedConversationIdentifier
        : this.resolveLatestUserMessageConversationIdentifier();
    const originalUserTaskReference = this.latestUserMessageReferences.get(
      conversationIdentifier ?? "",
    );
    if (originalUserTaskReference === undefined) {
      throw new DomainError(
        "invalid-task-chain",
        "提案必须引用一次用户原始任务；该会话没有已登记的用户消息。",
      );
    }
    const sourceActorIdentifier =
      await this.resolveMainAgentInstanceIdentifier(conversationIdentifier);
    return this.mainAgentProposalContract.submit(
      payload,
      {
        sourceActorIdentifier,
        authenticatedUserId: this.options.authenticatedUserId ?? null,
        originalUserTaskReference,
        conversationIdentifier: conversationIdentifier ?? null,
      },
      insertionController,
    );
  }

  /**
   * ALIGN-02-01：把用户原始任务登记进目标次级的版本化偏序集。
   *
   * - 目标次级标识**与调度器同源**（同一 mission 的调度主体）；
   * - 来源恒为 `user`、层级 0、保留原指令（截断只影响标题，`externalReference`
   *   回指 mission，指令原文仍在 mission 摘要里）；
   * - 匿名（无认证用户）**不登记**：宁可没有序列记录，也不伪造用户来源；
   * - 未装配序列控制面 ⇒ 返回 null（旧行为），下游按"无权威来源"处理。
   */
  private async registerUserTaskInSequence(input: {
    readonly missionId: string;
    readonly instructionText: string;
    readonly secondaryAgentInstanceId: string;
  }): Promise<{
    readonly taskSequenceIdentifier: string;
    readonly taskIdentifier: string;
  } | null> {
    const sequenceController = this.options.taskSequenceManageController;
    if (sequenceController === null || sequenceController === undefined) {
      return null;
    }
    const authenticatedUserId = this.options.authenticatedUserId?.trim();
    if (authenticatedUserId === undefined || authenticatedUserId === "") {
      return null;
    }
    const taskSequenceIdentifier = `sequence-${input.secondaryAgentInstanceId}`;
    const taskIdentifier = `task-${input.missionId}`;
    const trimmedInstruction = input.instructionText.trim();
    const registration = await sequenceController.publishOrInsertTask({
      ownerAgentInstanceId: input.secondaryAgentInstanceId,
      actor: { sourceKind: "user", actorId: authenticatedUserId },
      sequenceId: taskSequenceIdentifier,
      task: {
        taskId: taskIdentifier,
        title:
          trimmedInstruction === ""
            ? "（空指令）"
            : trimmedInstruction.slice(0, 120),
        priorityTier: 0,
        externalReference: `mission:${input.missionId}`,
      },
      anchor: { predecessorTaskIds: [], successorTaskIds: [] },
    });
    this.missionTaskSequences.set(input.missionId, {
      taskSequenceIdentifier: registration.document.sequenceId,
      taskIdentifier: registration.taskIdentifier,
      ownerAgentInstanceIdentifier: input.secondaryAgentInstanceId,
      sequenceRevision: registration.document.revision,
      isSequenceCreated: registration.isSequenceCreated,
    });
    return {
      taskSequenceIdentifier: registration.document.sequenceId,
      taskIdentifier: registration.taskIdentifier,
    };
  }

  /**
   * ALIGN-02-06（2026-10-28）：**运行中插入**任务（本地判定 + 安全分支）。
   *
   * 分支语义：
   * - 能进入当前组（`insert-now`）且装配了注入端口 ⇒ 交由端口在安全点注入；
   * - 否则（组已关闭 / 锚点后已有工具调用 / **尚未装配注入端口**）⇒ 把任务登记进
   *   同一权威序列等待下一组，并如实返回原因；
   * - 幂等键重复 ⇒ 复用；revision 过期或锚点非法 ⇒ 拒绝（要求重新读取状态）。
   *
   * 不提供"立即改写正在运行的任务链"的入口 —— 已发出的工具调用不可能被安全改写。
   */
  async requestRuntimeTaskInsertion(payload: unknown): Promise<{
    readonly outcome: TaskGroupInsertionOutcome | "inserted" | "deferred-to-sequence";
    readonly reason: string;
    readonly taskSequenceIdentifier: string | null;
    readonly taskIdentifier: string | null;
  }> {
    const request = parseRuntimeTaskInsertionRequest(payload);
    const sequenceMapping = this.missionTaskSequences.get(request.missionIdentifier);
    const sequenceController = this.options.taskSequenceManageController;
    if (sequenceMapping === undefined || sequenceController === null || sequenceController === undefined) {
      throw new DomainError(
        "invalid-task-chain",
        "该 mission 没有权威任务序列投影，无法登记运行中插入（拒绝静默丢弃）。",
      );
    }
    const missionStatus = await this.options.missionManager.getMissionStatus(
      request.missionIdentifier,
    );
    if (sequenceMapping.sequenceRevision === 0) {
      /**
       * ALIGN-04-01：关系索引不保存序列 revision ⇒ 重启恢复后为"未知"。
       * 不能拿 0 去比对（那会把一切都判成过期），要求调用方重新读取后再插入。
       */
      throw new DomainError(
        "stale-revision",
        "任务序列 revision 未知（重启恢复后需重新读取序列）——拒绝凭旧值插入。",
      );
    }
    const taskStates: Record<string, string> = {};
    for (const task of missionStatus.taskChain?.tasks ?? []) {
      taskStates[task.id] = task.status;
    }
    const decision = decideTaskGroupInsertion({
      request,
      group: {
        groupIdentifier: sequenceMapping.taskSequenceIdentifier,
        revision: sequenceMapping.sequenceRevision,
        isClosed:
          missionStatus.summary === null || missionStatus.summary.status !== "running",
        taskStates,
        /**
         * 只要组内还有 `running` 任务，就视为"锚点之后已有已发出的工具调用"：
         * 无法判断它是否已进入工具调用，按**保守**处理（等待下一组）。
         */
        hasIssuedToolCallsAfterAnchor: Object.values(taskStates).some(
          (status) => status === "running",
        ),
      },
      existingRequestFingerprint:
        this.insertionRequestFingerprints.get(request.requestIdentifier) ?? null,
    });

    if (decision.outcome === "duplicate") {
      return {
        outcome: "duplicate",
        reason: decision.reason,
        taskSequenceIdentifier: sequenceMapping.taskSequenceIdentifier,
        taskIdentifier: null,
      };
    }
    if (decision.outcome === "idempotency-conflict") {
      throw new DomainError("task-priority-denied", decision.reason);
    }
    if (decision.outcome === "stale-revision-rejected") {
      throw new DomainError("stale-revision", decision.reason);
    }
    if (decision.outcome === "invalid-anchor-rejected") {
      throw new DomainError("dependency-not-found", decision.reason);
    }

    const insertionPort = this.options.taskGroupInsertionPort;
    if (decision.outcome === "insert-now" && insertionPort !== undefined) {
      const isInserted = await insertionPort({
        missionIdentifier: request.missionIdentifier,
        request,
        groupIdentifier: sequenceMapping.taskSequenceIdentifier,
      });
      if (isInserted) {
        this.insertionRequestFingerprints.set(
          request.requestIdentifier,
          computeInsertionRequestFingerprint(request),
        );
        return {
          outcome: "inserted",
          reason: "已在安全上下文边界注入当前组",
          taskSequenceIdentifier: sequenceMapping.taskSequenceIdentifier,
          taskIdentifier: null,
        };
      }
    }

    /**
     * 推迟到下一组：登记进同一序列。锚点在 mission 任务链里（如 `T-001`）时
     * 序列中并不存在，故以前序用户任务作为锚点（保证偏序合法、不丢任务）。
     */
    const deferredTaskIdentifier = `task-insert-${createHash("sha256")
      .update(request.requestIdentifier)
      .digest("hex")
      .slice(0, 12)}`;
    const registration = await sequenceController.publishOrInsertTask({
      ownerAgentInstanceId: sequenceMapping.ownerAgentInstanceIdentifier,
      actor: { sourceKind: "agent", actorId: sequenceMapping.ownerAgentInstanceIdentifier },
      sequenceId: sequenceMapping.taskSequenceIdentifier,
      task: {
        taskId: deferredTaskIdentifier,
        title: request.title,
        priorityTier: null,
        externalReference: `insert-request:${request.requestIdentifier}`,
      },
      anchor: { predecessorTaskIds: [sequenceMapping.taskIdentifier], successorTaskIds: [] },
    });
    sequenceMapping.sequenceRevision = registration.document.revision;
    this.insertionRequestFingerprints.set(
      request.requestIdentifier,
      computeInsertionRequestFingerprint(request),
    );
    return {
      outcome: "deferred-to-sequence",
      reason:
        decision.outcome === "deferred-to-next-group"
          ? decision.reason
          : `${decision.reason}；但编排器尚未装配组内注入端口，已保留到下一组`,
      taskSequenceIdentifier: registration.document.sequenceId,
      taskIdentifier: registration.taskIdentifier,
    };
  }

  /**
   * ALIGN-03-01（2026-10-28）：任命执行/测试/验收的三级个体（本地控制面，非模型工具）。
   *
   * 额外约束：验收者必须是**任命次级**名下已登记的三级个体（不得跨 mission/跨上级借人），
   * 且任命者本人不得担任验收者。身份隔离规则复用 `AgentAppointmentRegistry`。
   */
  appointExecutionAndReview(input: AppointIndependentReviewInput): {
    readonly appointmentIdentifier: string;
  } {
    this.resolveIndependentReviewGate().appoint(input);
    return { appointmentIdentifier: input.appointmentIdentifier };
  }

  /**
   * ALIGN-03-01：记录**独立**验收裁决。
   *
   * 拒绝三类情况：裁决者非任命验收者（既有门禁）、裁决者是实现/测试者（纵深防御）、
   * **证据只有执行者自报**（自报不能代替独立审查结论）。
   */
  async recordAcceptanceVerdict(input: RecordIndependentVerdictInput): Promise<void> {
    await this.resolveIndependentReviewGate().recordVerdict(input);
  }

  /** ALIGN-03-01：合并就绪评估（委托既有验收门禁）。 */
  evaluateTaskMergeReadiness(
    input: Parameters<IndependentReviewGate["evaluateMergeReadiness"]>[0],
  ) {
    return this.resolveIndependentReviewGate().evaluateMergeReadiness(input);
  }

  private resolveIndependentReviewGate(): IndependentReviewGate {
    if (this.independentReviewGateInstance !== null) {
      return this.independentReviewGateInstance;
    }
    const facade = this.options.t08cRoutingFacade;
    if (facade === null || facade === undefined) {
      throw new DomainError(
        "invalid-task-chain",
        "四层路由控制面未装配：无法任命执行/测试/验收，也无法记录独立审查结论。",
      );
    }
    this.independentReviewGateInstance = new IndependentReviewGate({
      appointmentRegistry: facade.appointmentRegistry,
      acceptanceVerdictGate: facade.acceptanceVerdictGate,
      registeredAgentDirectory: this.options.registeredAgentDirectory ?? null,
    });
    return this.independentReviewGateInstance;
  }

  /**
   * ALIGN-04-01（2026-10-28）：登记 mission 的显式关联。
   *
   * 只写"本次确实知道"的字段；缺失就留空（不按名字/路径补）。写失败通过流式输出
   * 如实告知，不让调用方误以为索引已落盘。
   */
  private async recordMissionRelation(input: {
    readonly missionId: string;
    readonly projectIdentifier: string | undefined;
    readonly conversationIdentity: {
      readonly conversationIdentifier: string;
      readonly mainAgentInstanceIdentifier: string;
    } | null;
    readonly userTaskSequence: {
      readonly taskSequenceIdentifier: string;
      readonly taskIdentifier: string;
    } | null;
    readonly targetAgentInstanceIdentifier: string | undefined;
    readonly mode: AgentMode;
  }): Promise<void> {
    const store = this.options.missionRelationIndexStore;
    if (store === null || store === undefined) {
      return;
    }
    const sequenceMapping = this.missionTaskSequences.get(input.missionId);
    const agentInstanceIdentifiers = [
      ...(input.conversationIdentity === null
        ? []
        : [input.conversationIdentity.mainAgentInstanceIdentifier]),
      ...(sequenceMapping === undefined
        ? []
        : [sequenceMapping.ownerAgentInstanceIdentifier]),
      ...(input.targetAgentInstanceIdentifier === undefined ||
      input.targetAgentInstanceIdentifier === ""
        ? []
        : [input.targetAgentInstanceIdentifier]),
    ];
    try {
      await store.upsert({
        missionIdentifier: input.missionId,
        projectIdentifier: input.projectIdentifier ?? null,
        conversationIdentifier:
          input.conversationIdentity?.conversationIdentifier ?? null,
        mainAgentInstanceIdentifier:
          input.conversationIdentity?.mainAgentInstanceIdentifier ?? null,
        taskSequenceIdentifier:
          input.userTaskSequence?.taskSequenceIdentifier ?? null,
        taskIdentifier: input.userTaskSequence?.taskIdentifier ?? null,
        sequenceOwnerAgentInstanceIdentifier:
          sequenceMapping?.ownerAgentInstanceIdentifier ?? null,
        agentInstanceIdentifiers,
      });
    } catch (error) {
      this.options.streamOutput(
        input.missionId,
        `[关系索引] 写入失败（重启后该任务将缺少映射，不会按名字猜测）: ${(error as Error).message}`,
      );
    }
  }

  /**
   * ALIGN-04-01（2026-10-28）：**从权威关系索引恢复** mission 映射。
   *
   * 只在"记录里明确写过"时恢复；会话标识会与身份存储核对，对不上就**不恢复**
   * 并计入 `unresolvedConversationCount`（绝不按昵称/路径猜归属）。
   * 序列 revision 不从关系索引推断：恢复后置 0（未知），要求调用方重新读取。
   */
  async hydratePersistedMissionRelations(): Promise<{
    readonly restoredMissionCount: number;
    readonly restoredConversationCount: number;
    readonly unresolvedConversationCount: number;
  }> {
    const store = this.options.missionRelationIndexStore;
    if (store === null || store === undefined) {
      return {
        restoredMissionCount: 0,
        restoredConversationCount: 0,
        unresolvedConversationCount: 0,
      };
    }
    const records = await store.listAll();
    const conversationStore = this.options.conversationIdentityStore ?? null;
    let restoredMissionCount = 0;
    let restoredConversationCount = 0;
    let unresolvedConversationCount = 0;
    for (const record of records) {
      let conversationIdentifier = record.conversationIdentifier;
      if (conversationIdentifier !== null) {
        const conversationRecord =
          conversationStore === null
            ? null
            : await conversationStore.getConversation(conversationIdentifier);
        if (conversationRecord === null) {
          /** 记录里有、身份存储里查不到 ⇒ 不恢复（也不改写成别的会话）。 */
          unresolvedConversationCount += 1;
          conversationIdentifier = null;
        } else {
          restoredConversationCount += 1;
        }
      }
      if (record.projectIdentifier !== null) {
        this.missionProjectIdentifiers.set(
          record.missionIdentifier,
          record.projectIdentifier,
        );
      }
      if (conversationIdentifier !== null) {
        this.missionConversationIdentifiers.set(
          record.missionIdentifier,
          conversationIdentifier,
        );
      }
      if (
        record.taskSequenceIdentifier !== null &&
        record.taskIdentifier !== null &&
        record.sequenceOwnerAgentInstanceIdentifier !== null
      ) {
        this.missionTaskSequences.set(record.missionIdentifier, {
          taskSequenceIdentifier: record.taskSequenceIdentifier,
          taskIdentifier: record.taskIdentifier,
          ownerAgentInstanceIdentifier: record.sequenceOwnerAgentInstanceIdentifier,
          /** 关系索引不保存序列 revision ⇒ 标记为未知（0），插入前必须重新读取。 */
          sequenceRevision: 0,
          isSequenceCreated: false,
        });
      }
      restoredMissionCount += 1;
    }
    return {
      restoredMissionCount,
      restoredConversationCount,
      unresolvedConversationCount,
    };
  }

  /**
   * ALIGN-04-04（2026-10-28）：**工作时段恢复的同一入口**。
   *
   * 判定由 `evaluateWorkWindowResume`（既有纯函数）给出；只有 `resume-once` 才调用
   * **同一个** `resumeMission`（不新建队列/不建第二套恢复逻辑）。
   * - `pauseKind: "manual"` ⇒ 按"手动取消"抑制（人工暂停不因时段变化而复活）；
   * - `pauseKind: "rest"` ⇒ 只有 rest→working 变化才恢复一次；
   * - 已在运行/已被拒 ⇒ 如实返回 `didResume:false` 与原因。
   */
  async handleWorkWindowResume(input: {
    readonly missionIdentifier: string;
    readonly previousState: "working" | "resting";
    readonly currentState: "working" | "resting";
    readonly hasPendingResume: boolean;
    readonly isManuallyCancelled: boolean;
    readonly hasResumedSinceWake: boolean;
    /** 暂停来源：人工暂停不会被时段恢复唤醒；休息暂停才允许恢复。 */
    readonly pauseKind: "manual" | "rest";
  }): Promise<{
    readonly decision: WorkWindowResumeDecision["kind"] | "already-running" | "resume-rejected";
    readonly reason: string;
    readonly didResume: boolean;
  }> {
    const decision = evaluateWorkWindowResume({
      previousState: input.previousState,
      currentState: input.currentState,
      hasPendingResume: input.hasPendingResume,
      /** 人工暂停优先于一切：即使调用方没把 flag 置真，也按手动取消处理。 */
      isManuallyCancelled: input.isManuallyCancelled || input.pauseKind === "manual",
      hasResumedSinceWake: input.hasResumedSinceWake,
    });
    if (decision.kind !== "resume-once") {
      return { decision: decision.kind, reason: decision.reason, didResume: false };
    }
    if (this.activeOrchestrators.has(input.missionIdentifier)) {
      this.options.secondaryDispatchLoop?.notifySchedulingEvent("work-window-resumed");
      return {
        decision: "already-running",
        reason: "该 mission 已有活动调度器：不重复调度（同一任务不跑两遍）。",
        didResume: false,
      };
    }
    try {
      await this.resumeMission(input.missionIdentifier);
    } catch (error) {
      return {
        decision: "resume-rejected",
        reason: `恢复未执行（保持不可用状态）: ${(error as Error).message}`,
        didResume: false,
      };
    }
    this.options.secondaryDispatchLoop?.notifySchedulingEvent("work-window-resumed");
    return { decision: "resume-once", reason: decision.reason, didResume: true };
  }

  /**
   * ALIGN-04-05（2026-10-28）：**按节点关闭/回访重建必要上下文**（只读，不改任务状态）。
   *
   * 只沿 `ContextRecallController.recall` 的既有约束：调用者身份由 harness 注入、
   * 绑定节点 revision/原因码/token 上限、冷却与任务级预算、敏感内容命中即丢弃。
   * 内容来源是**该调用者可见的关闭胶囊**；不把全局摘要当完整历史，
   * 也不拼接其他角色日志（控制器没有这种输入面）。
   */
  async recallClosedContext(input: {
    readonly callerAgentInstanceId: string;
    readonly request: unknown;
    readonly nowMilliseconds?: number;
  }): Promise<ContextRecallResult> {
    const factory = this.options.contextRecallControllerFactory;
    if (factory === undefined) {
      throw new DomainError(
        "context-recall-invalid",
        "回访控制器未装配：无法按节点关闭重建上下文（拒绝伪造历史）。",
      );
    }
    if (input.callerAgentInstanceId.trim() === "") {
      throw new DomainError("context-recall-invalid", "调用者身份缺失（由 harness 注入）。");
    }
    const controller = factory(input.callerAgentInstanceId);
    return controller.recall({
      callerAgentInstanceId: input.callerAgentInstanceId,
      request: input.request,
      ...(input.nowMilliseconds === undefined
        ? {}
        : { nowMilliseconds: input.nowMilliseconds }),
    });
  }

  /**
   * ALIGN-04-03（2026-10-28）：只读的"恢复就绪"投影（对账用，**不启动任务**）。
   *
   * 与 `resumeMission` 用同一份判定逻辑，供 UI/CLI 在恢复前展示：
   * 哪些已完成、哪些 ready、哪些等依赖、哪些副作用未知/待裁决/已产出未回执。
   */
  async inspectMissionResumeReadiness(missionId: string): Promise<{
    readonly missionIdentifier: string;
    readonly isAutoResumable: boolean;
    readonly readyPendingTaskIdentifiers: readonly string[];
    readonly waitingDependencyTaskIdentifiers: readonly string[];
    readonly uncertainSideEffectTaskIdentifiers: readonly string[];
    readonly blockedAwaitingDecisionTaskIdentifiers: readonly string[];
    readonly producedButUnacknowledgedTaskIdentifiers: readonly string[];
    readonly blockedReasons: readonly string[];
  }> {
    const missionStatus = await this.options.missionManager.getMissionStatus(missionId);
    if (missionStatus.taskChain === null) {
      return {
        missionIdentifier: missionId,
        isAutoResumable: false,
        readyPendingTaskIdentifiers: [],
        waitingDependencyTaskIdentifiers: [],
        uncertainSideEffectTaskIdentifiers: [],
        blockedAwaitingDecisionTaskIdentifiers: [],
        producedButUnacknowledgedTaskIdentifiers: [],
        blockedReasons: ["mission 任务链不存在"],
      };
    }
    return {
      missionIdentifier: missionId,
      ...this.projectMissionResumeReadiness(missionStatus.taskChain),
    };
  }

  /** ALIGN-04-03：判定"能不能自动恢复"，并分类列出原因（纯函数式，只读输入）。 */
  private projectMissionResumeReadiness(taskChain: TaskChainDocument): {
    isAutoResumable: boolean;
    readyPendingTaskIdentifiers: string[];
    waitingDependencyTaskIdentifiers: string[];
    uncertainSideEffectTaskIdentifiers: string[];
    blockedAwaitingDecisionTaskIdentifiers: string[];
    producedButUnacknowledgedTaskIdentifiers: string[];
    blockedReasons: string[];
  } {
    const completedTaskIdentifiers = new Set(
      taskChain.tasks.filter((task) => task.status === "done").map((task) => task.id),
    );
    const readyPendingTaskIdentifiers: string[] = [];
    const waitingDependencyTaskIdentifiers: string[] = [];
    const uncertainSideEffectTaskIdentifiers: string[] = [];
    const blockedAwaitingDecisionTaskIdentifiers: string[] = [];
    const producedButUnacknowledgedTaskIdentifiers: string[] = [];
    for (const task of taskChain.tasks) {
      if (task.status === "done") {
        continue;
      }
      /**
       * 崩溃时处于 `running` ⇒ 可能已产生副作用但无回执：**不自动重跑**。
       * `blocked` ⇒ 等待裁决（不确定副作用/等待授权）：同样不自动放行。
       */
      if (task.status === "running") {
        uncertainSideEffectTaskIdentifiers.push(task.id);
        continue;
      }
      if (task.status === "blocked") {
        blockedAwaitingDecisionTaskIdentifiers.push(task.id);
        continue;
      }
      /** 已产出（有 resultLocation）但尚未 done ⇒ 先对账，不盲目重跑。 */
      if (task.resultLocation !== null && task.resultLocation !== "") {
        producedButUnacknowledgedTaskIdentifiers.push(task.id);
        continue;
      }
      if (task.status === "pending") {
        const isReady = task.dependsOn.every((dependencyId) =>
          completedTaskIdentifiers.has(dependencyId),
        );
        (isReady ? readyPendingTaskIdentifiers : waitingDependencyTaskIdentifiers).push(
          task.id,
        );
      }
    }
    const blockedReasons: string[] = [];
    if (uncertainSideEffectTaskIdentifiers.length > 0) {
      blockedReasons.push(
        `运行中任务副作用未知，需先对账: ${uncertainSideEffectTaskIdentifiers.join(", ")}`,
      );
    }
    if (blockedAwaitingDecisionTaskIdentifiers.length > 0) {
      blockedReasons.push(
        `阻塞任务等待裁决: ${blockedAwaitingDecisionTaskIdentifiers.join(", ")}`,
      );
    }
    if (producedButUnacknowledgedTaskIdentifiers.length > 0) {
      blockedReasons.push(
        `任务已产出但未回执，需先对账: ${producedButUnacknowledgedTaskIdentifiers.join(", ")}`,
      );
    }
    return {
      isAutoResumable: blockedReasons.length === 0,
      readyPendingTaskIdentifiers,
      waitingDependencyTaskIdentifiers,
      uncertainSideEffectTaskIdentifiers,
      blockedAwaitingDecisionTaskIdentifiers,
      producedButUnacknowledgedTaskIdentifiers,
      blockedReasons,
    };
  }

  /**
   * ALIGN-04-03：恢复前的**租约幂等领取**。
   *
   * - 无租约 ⇒ 交给编排器正常领取；
   * - 别的进程持有**活动**租约 ⇒ 拒绝（不抢正在跑的 mission）；
   * - 过期租约（原进程已死） ⇒ 按 revision 乐观接管，重试幂等；
   * - 本进程已持有 ⇒ 什么都不做（`tryAcquire` 会返回 `acquired-reentrant`）。
   */
  private async prepareResumeLease(missionId: string): Promise<void> {
    const leaseStore = this.options.missionLeaseStore;
    const processInstanceId = this.options.processInstanceId;
    if (leaseStore === null || leaseStore === undefined || processInstanceId === undefined) {
      return;
    }
    const leaseSummary = await leaseStore.readLeaseSummary(missionId, processInstanceId);
    if (!leaseSummary.exists) {
      return;
    }
    if (leaseSummary.isActive && !leaseSummary.isOwnedByCurrentProcess) {
      throw new DomainError(
        "mission-locked",
        `另一个进程持有活动租约（属主 ${leaseSummary.ownerProcessInstanceId ?? "未知"}）：不接管正在运行的 mission。`,
      );
    }
    if (!leaseSummary.isActive && leaseSummary.leaseRevision !== null) {
      await leaseStore.takeOverExpiredLease(missionId, leaseSummary.leaseRevision, {
        missionId,
        processInstanceId,
        purpose: "run",
        claimantDescription: "main-controller-resume",
      });
    }
  }

  /**
   * REMOTE-01-01（2026-10-28）：**项目持有者出具只读运行记录快照**。
   *
   * 只读、只取**已保存可展示记录**（mission 摘要/任务链、运行历史、产物登记、报告索引），
   * 不读取模型隐藏思维链；来源类型逐条标注；遗漏/截断/脱敏显式记账；
   * `isRealtime` 恒 false（本地快照是 last-known）。
   *
   * 未提供/不可用的来源不伪造：缺失原因进 `omissions.reasonCodes`。
   * 快照 revision 目前只在进程内递增（持久化与不可变存储属检查点 02）。
   */
  async requestRunEvidence(
    request: EvidenceSnapshotRequest,
  ): Promise<EvidenceSnapshot> {
    const candidateEntries: EvidenceSnapshotCandidateEntry[] = [];
    const additionalReasonCodes: string[] = [];
    const missionIdentifiers = [...request.missionIdentifiers];
    for (const missionIdentifier of missionIdentifiers) {
      const missionStatus = await this.options.missionManager
        .getMissionStatus(missionIdentifier)
        .catch(() => null);
      if (missionStatus === null) {
        additionalReasonCodes.push("mission-unavailable");
        continue;
      }
      if (missionStatus.summary !== null) {
        candidateEntries.push({
          entryIdentifier: `user-message:${missionIdentifier}`,
          sourceKind: "user-message",
          sourceAgentInstanceIdentifier: null,
          recordedAtIso: missionStatus.summary.createdAtIso,
          recordReference: `missions/${missionIdentifier}/summary.json`,
          excerptText: missionStatus.summary.prompt,
        });
      }
      for (const task of missionStatus.taskChain?.tasks ?? []) {
        if (task.status === "pending") {
          continue;
        }
        candidateEntries.push({
          entryIdentifier: `task-status:${missionIdentifier}:${task.id}`,
          sourceKind: "unknown",
          sourceAgentInstanceIdentifier: task.publishedByRecipientId ?? null,
          /**
           * 任务节点没有独立时间戳 ⇒ 取 mission 创建时间，并在摘录里注明，
           * 不假装是"状态变更时间"。
           */
          recordedAtIso:
            missionStatus.summary?.createdAtIso ?? new Date().toISOString(),
          recordReference: `missions/${missionIdentifier}/task-chain.json#${task.id}`,
          excerptText:
            `任务 ${task.id} 状态=${task.status}；结果位置=${task.resultLocation ?? "无"}；` +
            "（时间取 mission 创建时间，任务节点无独立时间戳）",
        });
      }
      const runHistoryStore = this.options.runHistoryStore;
      if (runHistoryStore === null || runHistoryStore === undefined) {
        additionalReasonCodes.push("run-history-unavailable");
      } else {
        const runHistory = await runHistoryStore
          .read(missionIdentifier)
          .catch(() => null);
        if (runHistory !== null && runHistory.kind === "valid") {
          for (const segment of runHistory.document.segments) {
            for (const event of segment.events) {
              const sourceKind: EvidenceSnapshotCandidateEntry["sourceKind"] =
                event.kind === "tool-call"
                  ? "tool-call"
                  : event.kind === "tool-failure"
                    ? "tool-result"
                    : event.kind === "model-note"
                      ? "model-claim"
                      : "unknown";
              candidateEntries.push({
                entryIdentifier: `run-event:${missionIdentifier}:${event.eventIdentifier}`,
                sourceKind,
                sourceAgentInstanceIdentifier: null,
                recordedAtIso: event.recordedAtIso,
                recordReference:
                  `run-history/${missionIdentifier}#${event.eventIdentifier}`,
                excerptText: event.payloadJson,
                /** 原文保留（默认原文摘录）；脱敏发生在投递侧并由外发门禁复核。 */
                isRedacted: false,
              });
            }
          }
        } else if (runHistory !== null && runHistory.kind === "invalid") {
          additionalReasonCodes.push("run-history-invalid");
        }
      }
      const reportIngestor = this.options.reportArchiveIngestor;
      if (reportIngestor === null || reportIngestor === undefined) {
        additionalReasonCodes.push("report-index-unavailable");
      } else {
        const indexEntries = await reportIngestor
          .readIndex(missionIdentifier)
          .catch(() => []);
        for (const indexEntry of indexEntries) {
          candidateEntries.push({
            entryIdentifier: `review:${indexEntry.reportId}`,
            sourceKind: "review-conclusion",
            sourceAgentInstanceIdentifier:
              indexEntry.reportingAgentInstanceId,
            recordedAtIso: indexEntry.recordedAtIso,
            recordReference:
              `main-agent-reports/${missionIdentifier}/${indexEntry.reportId}`,
            excerptText: indexEntry.summaryPreview,
          });
        }
      }
    }
    const artifactRecordStore = this.options.artifactRecordStore;
    if (artifactRecordStore === undefined) {
      additionalReasonCodes.push("artifact-store-unavailable");
    } else {
      const artifactDocument = await artifactRecordStore.read();
      for (const record of artifactDocument.records) {
        if (!missionIdentifiers.includes(record.missionIdentifier)) {
          continue;
        }
        candidateEntries.push({
          entryIdentifier: `artifact:${record.artifactIdentifier}`,
          sourceKind: "artifact-registration",
          sourceAgentInstanceIdentifier: record.sourceAgentInstanceId,
          recordedAtIso: record.createdAtIso,
          recordReference: `artifacts/records.json#${record.artifactIdentifier}`,
          excerptText:
            `产物 ${record.displayName}（${record.artifactType}）位置=${record.location}；` +
            `校验状态=${record.verificationStatus}`,
        });
      }
    }
    const snapshotRevision =
      (this.evidenceSnapshotRevisions.get(request.requestIdentifier) ?? 0) + 1;
    this.evidenceSnapshotRevisions.set(
      request.requestIdentifier,
      snapshotRevision,
    );
    return buildEvidenceSnapshot({
      request,
      candidateEntries,
      snapshotRevision,
      capturedAtIso: new Date().toISOString(),
      additionalReasonCodes: [...new Set(additionalReasonCodes)],
    });
  }

  /**
   * 接线缺口第 ① 项（2026-10-28）：**两套记账的只读对照**。
   *
   * 权威任务序列 vs mission 任务链：返回只在某一边的任务、状态不一致、ready 集合，
   * 并如实列出**当前不具备**的能力（按 taskId 派发/运行中插入/图变更）。
   * 只读：不改状态、不派发、不推进 revision。
   */
  async inspectTaskLedgerAlignment(input: {
    readonly missionIdentifier: string;
    readonly ownerAgentInstanceId: string;
    readonly sequenceId: string;
    readonly viewer: ActorIdentity;
  }): Promise<TaskLedgerAlignmentReport> {
    const statusController = this.options.taskSequenceStatusController;
    if (statusController === null || statusController === undefined) {
      throw new DomainError(
        "invalid-task-chain",
        "任务序列状态控制面未装配：无法对照两套记账（不伪造一致）。",
      );
    }
    const bridge = new TaskLedgerBridge({
      sequenceLedger: {
        getSnapshot: (snapshotInput) => statusController.getSnapshot(snapshotInput),
      },
      missionTaskChain: {
        getMissionStatus: (missionIdentifier) =>
          this.options.missionManager.getMissionStatus(missionIdentifier),
      },
    });
    return bridge.inspectAlignment(input);
  }

  /** ALIGN-01-03：生成并记住本次用户消息引用（harness 侧，模型不可填）。 */
  private rememberUserMessageReference(conversationIdentifier: string | null): string {    const userMessageReference = `user-message-${randomUUID()}`;
    this.latestUserMessageReferences.set(
      conversationIdentifier ?? "",
      userMessageReference,
    );
    return userMessageReference;
  }

  /** 最近一次用户消息所属会话（没有 ⇒ null；空串表示"无会话映射"）。 */
  private resolveLatestUserMessageConversationIdentifier(): string | null {
    let latestIdentifier: string | null = null;
    for (const conversationIdentifier of this.latestUserMessageReferences.keys()) {
      latestIdentifier = conversationIdentifier;
    }
    return latestIdentifier === "" ? null : latestIdentifier;
  }

  /** 提案来源个体：优先会话登记的主个体，其次装配层稳定 id；都没有即拒绝。 */
  private async resolveMainAgentInstanceIdentifier(
    conversationIdentifier: string | null,
  ): Promise<string> {
    const store = this.options.conversationIdentityStore;
    if (store !== null && store !== undefined && conversationIdentifier !== null) {
      const record = await store.getConversation(conversationIdentifier);
      if (record !== null) {
        return record.mainAgentInstanceIdentifier;
      }
    }
    const configuredIdentifier = this.options.mainAgentInstanceId?.trim();
    if (configuredIdentifier !== undefined && configuredIdentifier !== "") {
      return configuredIdentifier;
    }
    throw new DomainError(
      "task-sequence-permission-denied",
      "无法确定主 Agent 个体：拒绝以匿名来源提交提案。",
    );
  }

  /** 会话级/个体级提升列表（公开字段）。 */
  async listSessionElevations(sessionId: string) {
    const elevationStore = this.options.sessionElevationStore;
    if (elevationStore === null || elevationStore === undefined) {
      return [];
    }
    return (await elevationStore.listRecords(sessionId)).map((record) => ({
      elevationId: record.elevationId,
      scope: record.scope,
      capabilityId: record.capabilityId,
      resourceScope: record.resourceScope,
      originalDecision: record.originalDecision,
      elevatedDecision: record.elevatedDecision,
      createdAtIso: record.createdAtIso,
      expiresAtIso: record.expiresAtIso,
    }));
  }

  /** 认证用户创建会话/个体提升（不提供"提升主 Agent"）。 */
  async createSessionElevation(input: {
    sessionId: string;
    agentInstanceId: string | null;
    capabilityId: string;
    resourceScope: string;
    elevatedDecision: "allow" | "ask";
    expiresAtIso: string | null;
    userDecisionReference: string;
    currentSessionPermissionRevision: number;
  }): Promise<{
    elevationId: string;
    originalDecision: string;
    elevatedDecision: string;
  }> {
    const elevationController = this.options.sessionElevationController;
    const profileStore = this.options.permissionProfileStore;
    if (
      elevationController === null ||
      elevationController === undefined ||
      profileStore === null ||
      profileStore === undefined
    ) {
      throw new Error("会话提升控制面未装配");
    }
    // 基础决定从当前 profile 快照读取（可信来源）
    const reference = await this.getCurrentPermissionProfileReference();
    if (reference === null) {
      throw new Error("未选择当前权限组");
    }
    const profile = await profileStore.readProfile(reference);
    const originalDecision =
      profile.capabilityDecisions[input.capabilityId] ?? profile.fallbackDecision;
    if (originalDecision === "allow" && input.elevatedDecision === "ask") {
      throw new Error("提升方向必须更宽");
    }
    const scope =
      input.agentInstanceId === null
        ? { scope: "all-secondary-agents-in-session" as const }
        : {
            scope: "specific-secondary-agent" as const,
            agentInstanceId: input.agentInstanceId,
          };
    const record = await elevationController.createElevation({
      sessionId: input.sessionId,
      scope,
      capabilityId: input.capabilityId,
      resourceScope: input.resourceScope,
      baseProfileReference: reference,
      baseProfileRevision: profile.revision,
      catalogVersion: profile.catalogVersion,
      originalDecision,
      elevatedDecision: input.elevatedDecision,
      expiresAtIso: input.expiresAtIso,
      userDecisionReference: input.userDecisionReference,
      sessionPermissionRevision: input.currentSessionPermissionRevision,
    });
    return {
      elevationId: record.elevationId,
      originalDecision: record.originalDecision,
      elevatedDecision: record.elevatedDecision,
    };
  }

  /** 认证用户撤销提升。 */
  async revokeSessionElevation(input: {
    sessionId: string;
    elevationId: string;
  }): Promise<boolean> {
    const elevationController = this.options.sessionElevationController;
    if (elevationController === null || elevationController === undefined) {
      throw new Error("会话提升控制面未装配");
    }
    return elevationController.revokeElevation({
      sessionId: input.sessionId,
      elevationId: input.elevationId,
    });
  }

  /** 关闭会话（收敛 → 可选导出 → 无条件撤销全部提升）。 */
  async shutdownSession(input: {
    sessionId: string;
    exportPath: string | null;
  }): Promise<{
    closed: boolean;
    revokedElevationCount: number;
    exportWrote: boolean;
    exportFailedReason: string | null;
  }> {
    const shutdownCoordinator = this.options.sessionShutdownCoordinator;
    const elevationStore = this.options.sessionElevationStore;
    const exporter = this.options.sessionExporter;
    const profileStore = this.options.permissionProfileStore;
    if (
      shutdownCoordinator === null ||
      shutdownCoordinator === undefined ||
      elevationStore === null ||
      elevationStore === undefined
    ) {
      throw new Error("会话关闭协调器未装配");
    }
    let exportSnapshot = null;
    if (
      input.exportPath !== null &&
      exporter !== null &&
      exporter !== undefined &&
      profileStore !== null &&
      profileStore !== undefined
    ) {
      const currentReference = await this.getCurrentPermissionProfileReference();
      if (currentReference !== null) {
        const baseProfile = await profileStore.readProfile(currentReference);
        exportSnapshot = await exporter.exportEffectiveConfiguration({
          sessionId: input.sessionId,
          agentInstanceId: null,
          baseProfile,
          currentProfileReference: currentReference,
          elevationStore,
          resolver: this.options.sessionElevationResolver ?? (null as never),
          nowUnixMilliseconds: Date.now(),
          isAgentRetired: () => false,
          currentSessionPermissionRevision: 1,
        });
      }
    }
    return shutdownCoordinator.shutdownSession({
      sessionId: input.sessionId,
      drainInFlightCalls: async () => {},
      exportPath: input.exportPath,
      exportSnapshot,
    });
  }

  // ─── B6R-09：编排接入（提案/报告/生命周期） ────────────────────────────

  /** 主 Agent 提交任务插入提案（本地控制面验证；提交后立即回对话循环）。 */
  async submitTaskInsertionProposal(
    proposal: TaskInsertionProposal,
  ): Promise<void> {
    const insertionController = this.options.conversationTaskInsertionController;
    if (insertionController === null || insertionController === undefined) {
      throw new Error("对话任务插入控制面未装配");
    }
    await insertionController.submitProposal(proposal);
  }

  /** 登记 Agent（报告来源认证；不可复用身份）。 */
  registerAgent(input: {
    agentInstanceId: string;
    agentRole: "secondary" | "tertiary";
    missionId: string;
    owningSecondaryAgentInstanceId: string | null;
    boundTaskBundleId: string | null;
  }): void {
    const directory = this.options.registeredAgentDirectory;
    if (directory === null || directory === undefined) {
      throw new Error("Agent 注册目录未装配");
    }
    directory.registerAgent({
      agentInstanceId: input.agentInstanceId,
      agentRole: input.agentRole,
      missionId: input.missionId,
      owningSecondaryAgentInstanceId: input.owningSecondaryAgentInstanceId,
      boundTaskBundleId: input.boundTaskBundleId,
      registeredAtIso: new Date().toISOString(),
    });
  }

  /** 三级终态报告只写主 Agent 报告索引（不唤醒主 Agent 模型/不注入对话）。 */
  async ingestTertiaryTerminalReport(
    report: TertiaryTerminalReport,
  ): Promise<void> {
    const ingestor = this.options.reportArchiveIngestor;
    if (ingestor === null || ingestor === undefined) {
      throw new Error("报告索引未装配");
    }
    await ingestor.ingestReport(report);
  }

  /** 读取报告索引（主 Agent 后续轮次只读选择用）。 */
  async listReportIndex(missionId: string) {
    const ingestor = this.options.reportArchiveIngestor;
    if (ingestor === null || ingestor === undefined) {
      return [];
    }
    return ingestor.readIndex(missionId);
  }

  /**
   * ALIGN-01-06（2026-10-28）：**按需**读取相关报告（不自动注入主上下文）。
   *
   * 只读、token 预算有界、来源保留；调用方必须显式请求（例如用户后续
   * 提到该任务时），主 Agent 的每轮提示词**不会**自动带上全部报告。
   */
  async selectRelevantReports(input: {
    readonly missionId: string;
    readonly maxReports: number;
    readonly tokenBudgetTokens: number;
  }): Promise<TertiaryTerminalReport[]> {
    const ingestor = this.options.reportArchiveIngestor;
    if (ingestor === null || ingestor === undefined) {
      return [];
    }
    const reader = new MainAgentReportReader(ingestor, input.tokenBudgetTokens);
    return reader.selectReports({
      missionId: input.missionId,
      taskBundleIdFilter: null,
      maxReports: input.maxReports,
    });
  }

  /**
   * ALIGN-01-06：把**次级主体的终态**写入主 Agent 只读报告索引（带来源）。
   *
   * 关键边界：
   * - 来源必须是**已登记**的次级个体（`RegisteredAgentDirectory` 认证；
   *   未登记 ⇒ 报告层拒绝，不会因为"字符串非空"就当真）；
   * - 只写索引：不唤醒主 Agent 模型、不注入当前上下文、不打断用户输入；
   * - `executedChecks` 如实留空 —— 任务组终态没有可核对的命令/退出码时，
   *   不得编造"检查已通过"。
   *
   * 幂等：同一 mission/终态/摘要内容 → 同一 reportId（重复收口不重复写）；
   * 摘要变化（例如 blocked 后又 done）会生成第二条报告，如实保留两个终态事件。
   */
  private async ingestMissionTerminalReport(
    missionId: string,
    status: "done" | "cancelled" | "blocked",
  ): Promise<void> {
    const ingestor = this.options.reportArchiveIngestor;
    if (ingestor === null || ingestor === undefined) {
      return;
    }
    const reportingAgentInstanceId = this.resolveSecondaryAgentInstanceIdentifier(missionId);
    const missionStatus = await this.options.missionManager.getMissionStatus(missionId);
    const tasks = missionStatus.taskChain?.tasks ?? [];
    const completedTaskCount = tasks.filter((task) => task.status === "done").length;
    const reportKind: TertiaryTerminalReport["reportKind"] =
      status === "done" ? "completed" : status === "blocked" ? "blocked" : "terminated";
    const summary =
      `任务组终态 ${status}：任务 ${tasks.length} 个，已完成 ${completedTaskCount}，` +
      `未完成 ${tasks.length - completedTaskCount}。`;
    const summaryDigest = createHash("sha256").update(summary).digest("hex").slice(0, 8);
    await ingestor.ingestReport({
      reportId: `mission-report-${missionId}-${reportKind}-${summaryDigest}`,
      missionId,
      /** 任务组终态没有具体任务包 ⇒ 用 mission 作用域标识（来源认证按 mission 判定）。 */
      taskBundleId: "mission-scope",
      reportingAgentInstanceId,
      reportKind,
      summary,
      executedChecks: [],
      createdAtIso: new Date().toISOString(),
      contentHash: "",
    });
  }

  /**
   * ALIGN-01-06：mission 的次级主体标识（与调度器同源，不按角色名猜）。
   * 同时负责**登记**该主体，使报告来源认证有可信依据。
   */
  private resolveSecondaryAgentInstanceIdentifier(missionId: string): string {
    const agentInstanceId =
      this.options.secondaryAgentInstanceIdFactory?.(missionId) ??
      `scheduler:${missionId}`;
    const directory = this.options.registeredAgentDirectory;
    if (
      directory !== null &&
      directory !== undefined &&
      !directory.hasAgent(agentInstanceId)
    ) {
      directory.registerAgent({
        agentInstanceId,
        agentRole: "secondary",
        missionId,
        owningSecondaryAgentInstanceId: null,
        boundTaskBundleId: null,
        registeredAtIso: new Date().toISOString(),
      });
    }
    return agentInstanceId;
  }

  /** 次级持续调度循环（生产装配可达性 + 编排接入点）。 */
  getSecondaryDispatchLoop(): SecondaryContinuousDispatchLoop | null {
    return this.options.secondaryDispatchLoop ?? null;
  }

  /** 三级生命周期控制器（生产装配可达性 + 受控收口接入点）。 */
  getTertiaryLifecycleController(): TertiaryAgentLifecycleController | null {
    return this.options.tertiaryLifecycleController ?? null;
  }

  /** Worker 运行时组件（个体记忆/附件控制器；生产装配可达性）。 */
  getTertiaryRuntimeComponents() {
    return this.options.tertiaryRuntimeComponents ?? null;
  }

  /** T08C-07：四层路由控制面（直投/摘要/侦察/任命裁决/四级；三入口共用）。 */
  getT08cRoutingFacade(): T08cRoutingFacade | null {
    return this.options.t08cRoutingFacade ?? null;
  }

  /**
   * 向次级调度发送裁决指令（Assist）。
   *
   * 修复（2026-10-01）：调度器实例运行在**本进程**（`activeOrchestrators`），而
   * `scheduler:<missionId>` 的 mailbox 属于子进程；经反馈传输投递会被子进程标记已投递
   * 而不回传父进程（实测父进程 `onMessage` 从不触发），导致用户授权后的 `unblock`
   * 永远到不了调度器、任务停在 blocked。改为**同进程直接投递**；镜像一条反馈消息
   * 以保留审计/信箱语义（派发失败不影响裁决生效）。
   */
  sendSchedulerInstruction(missionId: string, instructionText: string): void {
    const activeEntry = this.activeOrchestrators.get(missionId);
    const schedulerWithInstruction = activeEntry?.scheduler as
      | { handleInstruction?: (instruction: string) => void }
      | undefined;
    if (typeof schedulerWithInstruction?.handleInstruction === "function") {
      schedulerWithInstruction.handleInstruction(instructionText);
    }
    void this.options.feedbackTransport
      .enqueue({
        protocolVersion: 1,
        messageId: randomUUID(),
        source: { sourceType: "user", sourceIdentifier: "main-controller" },
        recipientId: `scheduler:${missionId}`,
        priority: "instruction",
        createdAtIso: new Date().toISOString(),
        idempotencyKey: `main-instruction:${missionId}:${Date.now()}`,
      payload: { kind: "instruction", instructionText },
    });
  }

  private async resolveConversationIdentityForMission(
    projectIdentifier: string | undefined,
    input: { readonly requestedConversationIdentifier?: string },
  ): Promise<{
    readonly conversationIdentifier: string;
    readonly mainAgentInstanceIdentifier: string;
  } | null> {
    const store = this.options.conversationIdentityStore;
    if (store === null || store === undefined) {
      return null;
    }
    /**
     * 没有项目归属 ⇒ 不写会话映射。
     *
     * 卡内要求"不臆造归属"：把无项目的消息挂到某个默认项目上，会让
     * 重启恢复和历史视图把任务归错项目。这里宁可**不记录**会话。
     */
    if (projectIdentifier === undefined || projectIdentifier.trim() === "") {
      return null;
    }
    const record = await store.resolveOrOpenConversationForProject({
      projectIdentifier,
      ...(input.requestedConversationIdentifier === undefined
        ? {}
        : { conversationIdentifier: input.requestedConversationIdentifier }),
      ...(this.options.mainAgentInstanceId === undefined
        ? {}
        : { mainAgentInstanceIdentifier: this.options.mainAgentInstanceId }),
    });
    return {
      conversationIdentifier: record.conversationIdentifier,
      mainAgentInstanceIdentifier: record.mainAgentInstanceIdentifier,
    };
  }

  private async respondInPonderMode(
    message: string,
    identityInput: {
      readonly projectIdentifier?: string | undefined;
      readonly requestedConversationIdentifier?: string;
    } = {},
  ): Promise<void> {
    /**
     * ALIGN-01-02（2026-10-28）：**一次会话选择既有主个体，新调用只新建 run**。
     *
     * 旧行为是每次 `main:ponder:<随机>` ⇒ 个体每次不同、记忆无处归属。
     * 现在的顺序：
     *   1. 有会话映射 ⇒ 用该会话登记过的**主个体**（不按角色名猜、不新建）；
     *   2. 没有映射但装配层给了稳定主个体 ⇒ 用它；
     *   3. 只有在两者都没有时，才退回"本次调用临时 id"（并如实保留旧行为）。
     * 每次调用都登记一条 **无 mission 的 run**：run 与 mission 正交。
     */
    const conversationIdentity = await this.resolveConversationIdentityForMission(
      identityInput.projectIdentifier,
      identityInput.requestedConversationIdentifier === undefined
        ? {}
        : { requestedConversationIdentifier: identityInput.requestedConversationIdentifier },
    );
    const agentInstanceId =
      conversationIdentity?.mainAgentInstanceIdentifier ??
      this.options.mainAgentInstanceId ??
      `main:ponder:${randomUUID().slice(0, 8)}`;
    const userMessageReference = this.rememberUserMessageReference(
      conversationIdentity?.conversationIdentifier ?? null,
    );
    if (conversationIdentity !== null) {
      await this.options.conversationIdentityStore?.beginRun({
        conversationIdentifier: conversationIdentity.conversationIdentifier,
        agentInstanceIdentifier: agentInstanceId,
        userMessageReference,
      });
    }
    const runtime = this.options.mainRuntimeFactory(agentInstanceId);
    // T06B/ADR-0014：思索模式允许本地只读白名单工具（查看项目文件、检索文本、只读任务状态），
    // 其余工具不暴露；即便模型凭空构造调用，也由本地权限裁决与策略引擎 fail-closed。
    const ponderTooling =
      this.options.ponderReadonlyToolingFactory?.(agentInstanceId) ?? null;
    const ponderAgentRunInput = {
      missionId: null,
      agentId: agentInstanceId,
      systemPrompt:
        "你是主 Agent（思索模式）：可调用本地只读白名单工具查看项目文件、检索文本与查询只读任务状态；" +
        "禁止任何写入、删改、进程执行、安装、网络、备份或副作用不明确的工具；" +
        "禁止声称已执行实际未执行的操作。",
      userPrompt: message,
      availableToolDescriptors: ponderTooling?.toolDescriptors ?? [],
      maxLoopIterations:
        ponderTooling === null ? 1 : Math.max(2, this.options.maxLoopIterations),
    };
    const budgetMilliseconds =
      this.options.mainAgentTurnBudgetMilliseconds ??
      MAIN_AGENT_TURN_BUDGET_MILLISECONDS;
    const turnIdentifier = `main-agent-turn-${randomUUID()}`;
    const startedAtMilliseconds = Date.now();
    const cancellationController = new AbortController();
    /**
     * ALIGN-01-05：预算中止与调用方取消的组合信号。
     *
     * 没有这个组合，慢模型/无限重试会一直占住会话 —— 卡内明确禁止。
     */
    const deadlineSignal = AbortSignal.timeout(budgetMilliseconds);
    const combinedSignal = AbortSignal.any([
      cancellationController.signal,
      deadlineSignal,
    ]);
    let streamedCharacterCount = 0;
    let outcome: MainAgentTurnOutcome = "completed";
    try {
      const events =
        ponderTooling === null
          ? runtime.run(ponderAgentRunInput, combinedSignal)
          : await runToolLoop(ponderAgentRunInput, {
              runtime,
              toolPort: ponderTooling.toolPort,
              maxLoopIterations: ponderAgentRunInput.maxLoopIterations,
              cancellationSignal: combinedSignal,
            });
      for await (const event of events) {
        if (event.kind === "textDelta") {
          streamedCharacterCount += event.deltaText.length;
          this.options.streamOutput(null, event.deltaText);
        }
      }
    } catch (error) {
      if (deadlineSignal.aborted) {
        outcome = "timed-out";
      } else if (cancellationController.signal.aborted) {
        outcome = "cancelled";
      } else {
        throw error;
      }
    }
    const endedAtMilliseconds = Date.now();
    const progressRecord = buildMainAgentTurnProgressRecord({
      turnIdentifier,
      conversationIdentifier: conversationIdentity?.conversationIdentifier ?? null,
      startedAtMilliseconds,
      endedAtMilliseconds,
      budgetMilliseconds,
      outcome,
      streamedCharacterCount,
    });
    this.lastMainAgentTurnProgress = progressRecord;
    if (outcome === "timed-out") {
      /**
       * 超期必须**当场如实回报**：先落库（失败不阻塞），再明确告知"待补信息/待继续"。
       * 不写"已派发/已完成" —— 本轮确实没有派发任何任务。
       */
      try {
        await this.options.mainAgentTurnProgressPort?.(progressRecord);
      } catch {
        // 观测/落盘失败不得阻塞对话，也不掩盖超期事实
      }
      this.options.streamOutput(
        null,
        `[需要继续] ${progressRecord.nextActionText}`,
      );
    }
  }

  /**
   * G1（2026-11-08 第 253 轮）：把装配层的**半成品**补全成编排器要的完整对象。
   *
   * - `buildGitWorktreeToolPort`：带 `agentInstanceId`（权限按具体个体判定）；
   * - `isTargetBranchMergeAllowed`：**恒 false** —— 合并须人工体验 + 操作授权（`AGENTS.md`）。
   */
  private completeGitIntegrationOrchestrationOptions(
    missionId: string,
  ): GitIntegrationOrchestrationOptions | null {
    const partial = this.options.gitIntegration;
    if (partial === null || partial === undefined) return null;
    return {
      coordinator: partial.coordinator,
      repositoryPath: partial.repositoryPath,
      targetBranchName: partial.targetBranchName,
      allowedPathsByTaskType: partial.allowedPathsByTaskType,
      integrationTestCommands: partial.integrationTestCommands,
      buildGitWorktreeToolPort: (task, worktreePath, agentInstanceId) =>
        this.buildWorkerToolPortWithRecoveryCheckpointing(missionId, task, agentInstanceId),
      /**
       * G1 Step 3（第 261 轮）：**五门禁评估**（不再是无条件 `false`）。
       *
       * 当前**门④人工体验 / 门⑤操作授权没有装配来源**（只能由用户/平台提供），
       * 且前三门也尚无记录 ⇒ 结果恒为 `false`（行为与之前一致），但机制已可评估、可测试。
       * 接入来源后无需改这里，只需让证据字段非空。
       */
      isTargetBranchMergeAllowed: () =>
        evaluateMergeReadinessWithProvider(this.options.readMergeReadinessEvidence)
          .isMergeReady,
    };
  }

  private launchAssistMission(
    missionId: string,
    taskNodes: TaskChainDocument["tasks"],
  ): void {
    const initialChain = this.buildInitialChain(missionId, taskNodes);
    const scheduler = new AssistScheduler({
      missionId,
      initialChain,
      taskStore: this.options.taskStore,
      concurrency: this.options.concurrency,
      failureThreshold: this.options.failureThreshold,
      maxLoopIterations: this.options.maxLoopIterations,
      feedbackTransport: this.options.feedbackTransport,
      feedbackTransportFactory: async () => this.options.feedbackTransport,
      workArchiveStore: this.options.workArchiveStore ?? null,
      secondaryAgentInstanceId: this.resolveSecondaryAgentInstanceIdentifier(missionId),
      gitIntegration: this.completeGitIntegrationOrchestrationOptions(missionId),
      requireCompletionControlEvent: this.options.requireCompletionControlEvent ?? false,
      /** ALIGN-03-03：完成收据门禁（缺省关；开启后 success 无收据不判 done）。 */
      ...(this.options.isCompletionReceiptRequired === true
        ? { isCompletionReceiptRequired: true }
        : {}),
      onMissionGateBlocked: (failureReason) => {
        this.options.missionRuntimeRegistry?.release(missionId);
        this.options.streamOutput(missionId, `[需要用户] ${failureReason}`);
        void this.options.missionManager
          .updateMissionStatus(missionId, "blocked")
          .then(async () => {
            /** ALIGN-01-06：阻塞终态同样入索引（不注入上下文）。 */
            try {
              await this.ingestMissionTerminalReport(missionId, "blocked");
            } catch {
              // 索引失败不改变已确认的 blocked 终态
            }
          })
          .catch(() => {});
      },
      ...(this.options.isConversationMode === true ? { isConversationMode: true } : {}),
      // DIAG-01 采集（第 113 轮接线）：使命级诊断端口，缺省 ⇒ 不采集
      ...(this.options.missionDiagnosticEventPort === undefined
        ? {}
        : { missionDiagnosticEventPort: this.options.missionDiagnosticEventPort }),
      ...(this.options.workWindowGate === undefined
        ? {}
        : { workWindowGate: this.options.workWindowGate }),
      artifactWorkspaceRootPath:
        this.missionWorkspaceRootPaths.get(missionId) ?? this.options.artifactWorkspaceRootPath,
      contextPromptProvider: this.options.contextPromptProvider,
      guidanceControlQueue: this.options.guidanceControlQueue,
      contextNodeLifecycle: this.options.contextNodeLifecycle ?? null,
      contextLifecycleModeKey: "assist",
      /**
       * G5（2026-11-08 第 241 轮修复）：**必须放在顶层**。
       * 此前第 235 轮把它插进了 `workerFactories` 里 ⇒ 编排器读顶层 `this.options.isCheckpointResumeEnabled`
       * 永远 `undefined`（探针实测 `enabled=false`）。
       */
      ...(this.options.isCheckpointResumeEnabled === true
        ? { isCheckpointResumeEnabled: true }
        : {}),
      workerFactories: {
        runtimeFactory: (agentInstanceId, task) => {
          const lease = this.options.missionRuntimeRegistry?.get(missionId);
          const baseRuntime =
            lease === undefined || lease === null
              ? this.options.workerRuntimeFactory(agentInstanceId, task)
              : lease.runtime;
          return this.wrapRuntimeForWorkWindow(baseRuntime, missionId);
        },
        toolDescriptorFactory: this.options.resolveToolDescriptors,
        toolPortFactory: (task, agentInstanceId) =>
          this.buildWorkerToolPortWithRecoveryCheckpointing(
            missionId,
            task,
            agentInstanceId,
          ),
        buildPermissionExplanation: this.options.buildPermissionExplanation,
        ...(this.options.eventSourceHooks === undefined
          ? {}
          : { eventSourceHooks: this.options.eventSourceHooks }),
        // PERF-01-02 采集（第 83 轮接线）：缺省 ⇒ 不采集
        ...(this.options.perfSamplePort === undefined
          ? {}
          : { perfSamplePort: this.options.perfSamplePort }),
        /** G2（第 130 轮）：守卫端口转发。 */
        ...(this.options.progressGuardPort === undefined
          ? {}
          : { progressGuardPort: this.options.progressGuardPort }),
        /** G3（第 133 轮）：高严谨性开关转发（缺省 ⇒ 不传 ⇒ 不启用）。 */
        ...(this.options.isHighRigorEnforcementEnabled === undefined
          ? {}
          : { isHighRigorEnforcementEnabled: this.options.isHighRigorEnforcementEnabled }),
        /** G4（第 281 轮）：工具说明登记与注入器透传（缺省 ⇒ 不注入）。 */
        ...(this.options.toolDocumentationRegistry === undefined
          ? {}
          : { toolDocumentationRegistry: this.options.toolDocumentationRegistry }),
        ...(this.options.toolDocumentationInjector === undefined
          ? {}
          : { toolDocumentationInjector: this.options.toolDocumentationInjector }),
        /** HISTORY-01-02（第 42 轮）：运行历史存储透传。 */
        ...(this.options.runHistoryStore === undefined
          ? {}
          : { runHistoryStore: this.options.runHistoryStore }),
        // DIAG-01 采集（第 85 轮接线）：缺省 ⇒ 不采集
        ...(this.options.diagnosticEventPort === undefined
          ? {}
          : { diagnosticEventPort: this.options.diagnosticEventPort }),
      },
      onReportToMain: (message) => {
        if (message.payload.kind !== "instruction") {
          return;
        }
        if (message.payload.instructionText.startsWith("任务完成状态:")) {
          this.options.missionRuntimeRegistry?.release(missionId);
          const status = message.payload.instructionText.includes("done")
            ? "done"
            : "cancelled";
          this.options.onMissionFinished?.(missionId, status);
          void this.registerMissionArtifacts(missionId);
          /** ALIGN-02-07：任务收口 ⇒ 事件唤醒（让依赖解锁/补位不再靠轮询）。 */
          this.options.secondaryDispatchLoop?.notifySchedulingEvent("task-finished");
          return this.options.missionManager
            .updateMissionStatus(missionId, status)
            .then(async () => {
              /**
               * ALIGN-01-06：终态写入报告索引（只读索引，不注入上下文）。
               * 索引失败**不改变**任务终态 —— 状态以 mission 摘要为准。
               */
              try {
                await this.ingestMissionTerminalReport(missionId, status);
              } catch {
                // 报告索引是辅助观测；失败不覆盖已确认的终态
              }
            });
        }
        this.options.streamOutput(missionId, `[需要用户] ${message.payload.instructionText}`);
      },
      // GUI-02-01 片①：assist 路径同样把权限询问的**绝对身份**转发给宿主（可选）。
      ...(this.options.onPermissionAskWithIdentity === undefined
        ? {}
        : {
            onPermissionAskWithIdentity: (input: {
              ownerAgentInstanceId: string;
              taskId: string;
              message: string;
            }) => {
              this.options.onPermissionAskWithIdentity?.(input);
            },
          }),
      missionLeaseStore: this.options.missionLeaseStore ?? null,
      processInstanceId: this.options.processInstanceId,
    });
    this.activeOrchestrators.set(missionId, { scheduler, mode: "assist" });
    void this.startSchedulerSafely(missionId, scheduler);
  }

  private launchDevolveMission(
    missionId: string,
    taskNodes: TaskChainDocument["tasks"],
  ): void {
    const initialChain = this.buildInitialChain(missionId, taskNodes);
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore: this.options.taskStore,
      concurrency: this.options.concurrency,
      failureThreshold: this.options.failureThreshold,
      maxLoopIterations: this.options.maxLoopIterations,
      feedbackTransportFactory: async () => this.options.feedbackTransport,
      workArchiveStore: this.options.workArchiveStore ?? null,
      /**
       * ALIGN-01-06：devolve 模式**没有下级报告**（主 Agent 直接调度），
       * 因此这里只保留身份字符串，不登记为"次级"、也不往报告索引里写
       * "下级报告" —— 否则就是把主 Agent 自己的调度记成了下级的汇报。
       */
      secondaryAgentInstanceId:
        this.options.secondaryAgentInstanceIdFactory?.(missionId) ??
        `scheduler:${missionId}`,
      gitIntegration: this.completeGitIntegrationOrchestrationOptions(missionId),
      requireCompletionControlEvent: this.options.requireCompletionControlEvent ?? false,
      /** ALIGN-03-03：完成收据门禁（缺省关；开启后 success 无收据不判 done）。 */
      ...(this.options.isCompletionReceiptRequired === true
        ? { isCompletionReceiptRequired: true }
        : {}),
      onMissionGateBlocked: (failureReason) => {
        this.options.missionRuntimeRegistry?.release(missionId);
        this.options.streamOutput(missionId, `[需要用户] ${failureReason}`);
        void this.options.missionManager
          .updateMissionStatus(missionId, "blocked")
          .catch(() => {});
      },
      ...(this.options.isConversationMode === true ? { isConversationMode: true } : {}),
      // DIAG-01 采集（第 113 轮接线）：使命级诊断端口，缺省 ⇒ 不采集
      ...(this.options.missionDiagnosticEventPort === undefined
        ? {}
        : { missionDiagnosticEventPort: this.options.missionDiagnosticEventPort }),
      artifactWorkspaceRootPath:
        this.missionWorkspaceRootPaths.get(missionId) ?? this.options.artifactWorkspaceRootPath,
      contextPromptProvider: this.options.contextPromptProvider,
      guidanceControlQueue: this.options.guidanceControlQueue,
      contextNodeLifecycle: this.options.contextNodeLifecycle ?? null,
      contextLifecycleModeKey: "devolve",
      workerFactories: {
        runtimeFactory: (agentInstanceId, task) => {
          const lease = this.options.missionRuntimeRegistry?.get(missionId);
          const baseRuntime =
            lease === undefined || lease === null
              ? this.options.workerRuntimeFactory(agentInstanceId, task)
              : lease.runtime;
          return this.wrapRuntimeForWorkWindow(baseRuntime, missionId);
        },
        toolDescriptorFactory: this.options.resolveToolDescriptors,
        toolPortFactory: (task, agentInstanceId) =>
          this.buildWorkerToolPortWithRecoveryCheckpointing(
            missionId,
            task,
            agentInstanceId,
          ),
        buildPermissionExplanation: this.options.buildPermissionExplanation,
        // PERF-01-02 采集（第 83 轮接线）：缺省 ⇒ 不采集
        ...(this.options.perfSamplePort === undefined
          ? {}
          : { perfSamplePort: this.options.perfSamplePort }),
        /** G2（第 130 轮）：守卫端口转发。 */
        ...(this.options.progressGuardPort === undefined
          ? {}
          : { progressGuardPort: this.options.progressGuardPort }),
        /** G3（第 133 轮）：高严谨性开关转发（缺省 ⇒ 不传 ⇒ 不启用）。 */
        ...(this.options.isHighRigorEnforcementEnabled === undefined
          ? {}
          : { isHighRigorEnforcementEnabled: this.options.isHighRigorEnforcementEnabled }),
        /** G4（第 281 轮）：工具说明登记与注入器透传（缺省 ⇒ 不注入）。 */
        ...(this.options.toolDocumentationRegistry === undefined
          ? {}
          : { toolDocumentationRegistry: this.options.toolDocumentationRegistry }),
        ...(this.options.toolDocumentationInjector === undefined
          ? {}
          : { toolDocumentationInjector: this.options.toolDocumentationInjector }),
          /** HISTORY-01-02（第 51 轮修复）：devolve 路径同样透传运行历史存储。 */
          ...(this.options.runHistoryStore === undefined
            ? {}
            : { runHistoryStore: this.options.runHistoryStore }),
        // DIAG-01 采集（第 85 轮接线）：缺省 ⇒ 不采集
        ...(this.options.diagnosticEventPort === undefined
          ? {}
          : { diagnosticEventPort: this.options.diagnosticEventPort }),
      },
      onMissionFinished: (status) => {
        /**
         * ALIGN-01-06：devolve 没有下级报告 ⇒ 只更新 mission 终态，
         * 不往"主 Agent 只读报告索引"写一条伪下级报告。
         */
        void this.options.missionManager.updateMissionStatus(missionId, status);
        this.options.onMissionFinished?.(missionId, status);
        /** ALIGN-02-07：终态事件唤醒调度。 */
        this.options.secondaryDispatchLoop?.notifySchedulingEvent("task-finished");
      },
      onUserEscalation: (message) => {
        this.options.streamOutput(missionId, `[需要用户] ${message}`);
      },
      // GUI-02-01 片①：把权限询问的**绝对身份**转发给宿主（可选；未提供则不接线）。
      ...(this.options.onPermissionAskWithIdentity === undefined
        ? {}
        : {
            onPermissionAskWithIdentity: (input: {
              ownerAgentInstanceId: string;
              taskId: string;
              message: string;
            }) => {
              this.options.onPermissionAskWithIdentity?.(input);
            },
          }),
      missionLeaseStore: this.options.missionLeaseStore ?? null,
      processInstanceId: this.options.processInstanceId,
    });
    this.activeOrchestrators.set(missionId, { scheduler, mode: "devolve" });
    void this.startSchedulerSafely(missionId, scheduler);
  }

  /**
   * T12-02：安全启动编排会话。租约冲突（mission-locked）时把 mission
   * 置为 blocked 并转达用户，避免未处理拒绝导致进程崩溃或静默双跑。
   */
  private startSchedulerSafely(
    missionId: string,
    scheduler: AssistScheduler | DevolveScheduler,
  ): void {
    void scheduler.start()
      .then(() => {
        this.options.missionRuntimeRegistry?.release(missionId);
        /**
         * ALIGN-04-04：调度器结束后清掉"活动编排器"记录。
         * 否则 `resumeMission` 的幂等守卫会永远把该 mission 当成"仍在运行"。
         */
        this.activeOrchestrators.delete(missionId);
      })
      .catch((error: Error) => {
        this.options.missionRuntimeRegistry?.release(missionId);
      this.activeOrchestrators.delete(missionId);
      this.options.streamOutput(missionId, `[mission-locked] ${error.message}`);
      void this.options.missionManager
        .updateMissionStatus(missionId, "blocked")
        .catch(() => {});
      /**
       * DIAG-01（2026-11-08，第 114 轮）：**调度启动失败**此前只输出一行消息并把 mission 置 blocked，
       * 诊断存储**学不到**发生了什么 ⇒ 按 `stage: "dispatch"` 上报。
       *
       * 纪律同工具循环／编排器：**只加观测**（不取代上面那行输出、不改状态流转）、
       * **观测失败只丢弃**、**缺省不采集**（端口未提供 ⇒ 什么都不做）。
       */
      const missionDiagnosticEventPort = this.options.missionDiagnosticEventPort;
      if (missionDiagnosticEventPort !== undefined) {
        void Promise.resolve(
          missionDiagnosticEventPort({
            missionIdentifier: missionId,
            sourceAgentInstanceId: `scheduler:${missionId}`,
            stage: "dispatch",
            errorCode:
              error instanceof DomainError ? error.errorCode : "mission-start-failed",
            messageText: error.message,
            component: "mission-start",
          }),
        ).catch(() => {
          // 观测失败不得阻塞业务
        });
      }
    });
  }

  private wrapRuntimeForWorkWindow(runtime: AgentRuntime, missionId: string): AgentRuntime {
    const provider = this.options.workWindowGateDecisionProvider;
    if (provider === undefined) return runtime;
    const projectIdentifier = this.missionProjectIdentifiers.get(missionId) ?? null;
    return {
      async *run(input: AgentRunInput, signal: AbortSignal) {
        const decision = await provider({
          missionId,
          projectIdentifier,
          nowIso: new Date().toISOString(),
        });
        if (!decision.isAllowed) {
          yield {
            kind: "runFinished",
            agentId: input.agentId,
            reason: "error",
            detail: "work-window-resting: " + decision.reason,
          };
          return;
        }
        yield* runtime.run(input, signal);
      },
    };
  }

  private async registerMissionArtifacts(missionId: string): Promise<void> {
    const store = this.options.artifactRecordStore;
    if (store === undefined) return;
    const status = await this.options.missionManager.getMissionStatus(missionId);
    const projectIdentifier = this.missionProjectIdentifiers.get(missionId) ?? "workspace";
    for (const task of status.taskChain?.tasks ?? []) {
      if (typeof task.resultLocation !== "string" || task.resultLocation.trim() === "") continue;
      await store.register({
        projectIdentifier,
        missionIdentifier: missionId,
        taskIdentifier: task.id,
        artifactType: "task-result-location",
        displayName: task.description || task.id,
        location: task.resultLocation,
      }).catch(() => undefined);
    }
  }

  private buildInitialChain(
    missionId: string,
    taskNodes: TaskChainDocument["tasks"],
  ): TaskChainDocument {
    return {
      schemaVersion: 1,
      missionId,
      revision: 1,
      updatedAtIso: new Date().toISOString(),
      tasks: taskNodes,
    };
  }

  /**
   * 任务分解：v0.1 使用确定性分解（单任务）。
   * 真实 LLM 分解由次级 Agent 的运行时在 T14 演进中替换。
   */
  /**
   * 组装 worker 工具端口，并在装配了恢复检查点钩子时把装饰器套在**最外层**
   * （E2E-01-03 S2b；未装配时与既有行为逐字一致）。
   */
  private buildWorkerToolPortWithRecoveryCheckpointing(
    missionId: string,
    task: TaskDependencyNode,
    agentInstanceId: string | undefined,
  ): ToolPort {
    const targetAgentInstanceIdentifier =
      this.missionTargetAgentIdentifiers.get(missionId);
    const innerToolPort = this.options.buildWorkerToolPort(
      task,
      new Set(task.toolNames),
      targetAgentInstanceIdentifier ?? agentInstanceId,
      this.missionWorkspaceRootPaths.get(missionId),
      this.missionProjectIdentifiers.get(missionId),
      missionId,
    );
    const buildCheckpointingPort = this.options.buildRecoveryCheckpointingToolPort;
    if (buildCheckpointingPort === undefined) {
      return innerToolPort;
    }
    return buildCheckpointingPort({
      missionId,
      task,
      agentInstanceId: agentInstanceId ?? `worker:${task.id}`,
      innerToolPort,
    });
  }

  /**
   * ALIGN-02-02（2026-10-28）：规划一次任务分解（可选模型 + 本地强制校验）。
   *
   * 三种结果都必须可区分，**不得混为一谈**：
   * - `model`：候选稿通过本地校验（节点数/标识/依赖环/验收要求/工具子集/无越权字段）；
   * - `single-node-fallback`：有生产器但规划或校验失败 ⇒ 降级为单节点，
   *   原因写进摘要并即时告知用户；
   * - `legacy-single-node`：未装配生产器（旧行为），不声称"已规划"。
   */
  private async planTaskDecomposition(input: {
    readonly missionId: string;
    readonly instructionText: string;
    readonly projectIdentifier: string | null;
    readonly conversationIdentifier: string | null;
  }): Promise<{
    readonly nodes: TaskDependencyNode[];
    readonly outcome: "model" | "single-node-fallback" | "legacy-single-node";
    readonly fallbackReason: string | null;
  }> {
    const availableToolNames = this.options.registry
      .getFullDescriptors()
      .map((descriptor) => descriptor.name);
    const draftProvider = this.options.taskDecompositionDraftProvider;
    if (draftProvider === null || draftProvider === undefined) {
      return {
        ...buildSingleNodeDecomposition({
          instructionText: input.instructionText,
          availableToolNames,
          fallbackReason: null,
        }),
        outcome: "legacy-single-node",
      };
    }
    try {
      const projectSummary =
        (await this.options.projectSummaryProvider?.({
          projectIdentifier: input.projectIdentifier,
          conversationIdentifier: input.conversationIdentifier,
        })) ?? null;
      const draft = await draftProvider({
        missionIdentifier: input.missionId,
        instructionText: input.instructionText,
        projectSummary,
      });
      const nodes = parseAndValidateTaskDecomposition({ draft, availableToolNames });
      return { nodes, outcome: "model", fallbackReason: null };
    } catch (error) {
      const fallbackReason =
        error instanceof DomainError ? error.message : (error as Error).message;
      /**
       * 降级必须**可见**：既写进摘要，也即时告知用户 —— 否则用户会以为任务
       * 经过了分解，而实际只是一个单节点执行。
       */
      this.options.streamOutput(
        null,
        `[规划降级] 任务分解未通过本地校验，已退化为单节点执行（未经过规划）：${fallbackReason}`,
      );
      return {
        ...buildSingleNodeDecomposition({
          instructionText: input.instructionText,
          availableToolNames,
          fallbackReason,
        }),
        outcome: "single-node-fallback",
      };
    }
  }
}

