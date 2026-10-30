/**
 * 公共应用运行时装配（T07D-R1-01）：CLI/TUI/SDK 共用同一装配入口。
 * 交互端口由界面层注入；本模块不依赖 TUI/GUI（依赖方向：core 不反向依赖界面）。
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { resolveHostUserIdentifier } from "../core/host-user-context.js";
import { DomainError } from "../core/errors.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { EventControlChannel } from "../orchestration/event-control-channel.js";
import { EventIncidentJournal } from "../orchestration/event-incident-journal.js";
import { EventSourceBridge } from "../orchestration/event-source-bridge.js";

import { ModeMachine } from "../core/mode-machine.js";
import { SessionAuthorizationManager } from "../core/permission-policy.js";
import { PermissionDecider } from "../core/permission-policy.js";
import { TaskStore } from "../infra/task-store.js";
import { MissionLeaseStore } from "../infra/mission-lease-store.js";
import { ToolRegistry } from "../tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../tools/builtins.js";
import { PolicyWrapper } from "../tools/policy-wrapper.js";
import { WorkspaceBoundary } from "../tools/workspace-boundary.js";
import { FolderGrantStore } from "../orchestration/folder-grant-store.js";
import { detectFileSystemCaseSensitivity } from "../tools/cross-platform-path-canonicalization.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { MainController } from "../orchestration/main-controller.js";
// OBS-01／PERF-01-02（第 83 轮）：性能样本落库（此前只在生产里被构造用于"查询"）
import { PerfEventStore } from "../orchestration/perf-event-store.js";
// OBS-01／DIAG-01（第 85 轮）：诊断事件落库（同因：此前生产里无人**写入**）
import { DiagnosticEventStore } from "../orchestration/diagnostic-event-store.js";
import { LocalProgressAndCycleGuard } from "../tools/local-progress-and-cycle-guard.js";
import { TaskCallBudgetLedger } from "../infra/task-call-budget-ledger.js";
import { RunHistoryStore } from "../orchestration/run-history-store.js";
import { ConversationIdentityStore } from "../orchestration/conversation-identity-store.js";
import { MAIN_AGENT_TURN_BUDGET_MILLISECONDS } from "../orchestration/main-agent-turn-budget.js";
import {
  buildPlannerTaskPlaceholder,
  createModelBackedTaskDecompositionProvider,
} from "../orchestration/model-task-decomposition-planner.js";
import type { ToolPublicDocumentationRegistryEntry } from "../tools/tool-public-documentation-registry.js";
import {
  ToolDocumentationRecallInjector,
  ToolDocumentationReceiptStore,
} from "../tools/tool-documentation-recall.js";
import type { MissionDiagnosticEvent } from "../orchestration/mission-orchestrator.js";
// G1（2026-11-08 第 255 轮）：Git 集成四件套（装配层构造，缺省不启用）。
import { GitContributionVerifier } from "../orchestration/git-contribution-verifier.js";
import { GitIntegrationCoordinator } from "../orchestration/git-integration-coordinator.js";
import { GitIntegrationReportStore } from "../orchestration/git-integration-report-store.js";
import { GitRecoveryPointService } from "../orchestration/git-recovery-point-service.js";
import { GitWorktreeAllocator } from "../orchestration/git-worktree-allocator.js";
import { MissionManager } from "../orchestration/mission-manager.js";
import { FeedbackProcessSupervisor } from "../feedback-process/process-supervisor.js";
import type { ForkFeedbackClient } from "../feedback-process/transport.js";
import type {
  AgentRuntime,
  TaskDependencyNode,
  ToolDescriptor,
  ToolPort,
} from "../core/types.js";
import type { BackupDeletionAuthorizationControlPort } from "../core/types.js";
import type { InstallationGateUserPort } from "../tools/installation-gate-guard.js";
import {
  BackupDeletionAuditLog,
  BackupDeletionAuthorizationController,
  BackupVault,
} from "../tools/backup-vault.js";
import { ProtectedStoragePolicy } from "../tools/protected-storage-policy.js";
import { SensitiveContentAccessPolicy } from "../tools/sensitive-content-access-policy.js";
import {
  LocalToolPolicyEngine,
  PONDER_READONLY_TOOL_NAMES,
} from "../tools/local-tool-policy-engine.js";
import { EvidenceBundleBuilder } from "../tools/evidence-bundle-builder.js";
import { ReadSuppressionLedger } from "../tools/read-suppression-ledger.js";
import { AgentWorkArchiveStore } from "../orchestration/work-archive-store.js";
import { InstallationOperationClassifier } from "../tools/installation-operation-classifier.js";
import {
  AssistInstallationAuthorizationController,
  AssistInstallationSettingsStore,
  ExistingResourceInquiryController,
} from "../tools/assist-installation-gate.js";
import { InstallationGateGuard } from "../tools/installation-gate-guard.js";
import {
  ScopeAuthorizationGate,
  ScopeGatedToolPort,
  type ScopeGateSuperiorApprovalPort,
} from "../tools/scope-authorization-gate.js";
import type { RegisteredProjectRoot } from "../tools/scope-resolution.js";
import { PermissionCapabilityCatalog } from "../tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../tools/permission-profile-store.js";
import type { PermissionProfileReference } from "../tools/permission-profile-store.js";
import { ConfigurablePermissionPolicyEngine } from "../tools/configurable-permission-policy-engine.js";
import { CurrentPermissionSelectionStore } from "../tools/current-permission-selection.js";
import { MainAgentReadonlyToolProjection } from "../tools/main-agent-readonly-projection.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
} from "../tools/session-permission-elevation.js";
import {
  CurrentPermissionConfigurationExporter,
  SessionShutdownCoordinator,
} from "../tools/session-shutdown-and-export.js";
import { RegisteredAgentDirectory } from "../orchestration/registered-agent-directory.js";
import type { ProjectReconnaissanceController } from "../orchestration/project-reconnaissance-controller.js";
import { StandaloneWorkflowRunner } from "../orchestration/standalone-workflow-runner.js";
import type { TaskSequenceManageController } from "../orchestration/task-sequence-controllers.js";
import { MainAgentReportArchiveIngestor } from "../orchestration/main-agent-report-archive.js";
import { ConversationTaskInsertionController } from "../orchestration/conversation-task-insertion-controller.js";
import { UnboundedAgentInstanceRegistry } from "../orchestration/unbounded-agent-registry.js";
import { SecondaryContinuousDispatchLoop } from "../orchestration/secondary-continuous-dispatch-loop.js";
import {
  FileTertiaryLifecyclePhaseStore,
  TertiaryAgentLifecycleController,
} from "../orchestration/tertiary-lifecycle.js";
import { AgentIndividualMemoryStore } from "../orchestration/agent-individual-memory.js";
import { buildTertiaryLifecycleHooks } from "../orchestration/tertiary-lifecycle-hooks.js";
import { MissionRelationIndexStore } from "../orchestration/mission-relation-index.js";
import { RecoveryCenterController } from "../orchestration/recovery-center-controller.js";
import { CrossAgentContextAttachmentController } from "../orchestration/cross-agent-attachment-controller.js";
import { GlobalDecisionStore } from "../orchestration/global-decision-store.js";
import { GlobalContextBudgetStore } from "../orchestration/global-context-budget-store.js";
import { ScopedSettingsStore } from "../orchestration/scoped-settings-store.js";
import { AgentModelBindingStore } from "../orchestration/agent-model-binding-store.js";
import { MissionRuntimeRegistry } from "../orchestration/mission-runtime-registry.js";
import type { MissionRuntimeLease } from "../orchestration/mission-runtime-registry.js";
import { ArtifactRecordStore } from "../orchestration/artifact-record-store.js";
import { ProjectWorkWindowStore } from "../orchestration/project-work-window-store.js";
import { TaskLedgerDivergenceJournal } from "../orchestration/task-ledger-divergence-journal.js";
import { MissionSequenceBindingStore } from "../orchestration/mission-sequence-binding-store.js";
import { DeferredInsertionQueueStore } from "../orchestration/deferred-insertion-queue.js";
import { GoalModeStateStore, GOAL_MODE_STATE_SCHEMA_VERSION } from "../orchestration/goal-mode-store.js";
import type { GoalModeStatusView } from "../orchestration/goal-mode-store.js";
import type { PersistedGoalModeState } from "../orchestration/goal-mode-store.js";
import { GoalDispatchGate } from "../orchestration/goal-dispatch-gate.js";
import { GoalDispatchVerdictJournal } from "../orchestration/goal-dispatch-verdict-journal.js";
import { CompletionReceiptStore } from "../orchestration/completion-receipt-store.js";
import { CompletionVerdictStore } from "../orchestration/completion-verdict-store.js";
import { GoalContractStore } from "../orchestration/goal-contract-store.js";
import { GoalMissionBindingStore } from "../orchestration/goal-mission-binding-store.js";
import { GoalGateCache } from "../orchestration/goal-gate-cache.js";
import { resolveGoalModeActivation, computeGoalPotential } from "../orchestration/goal-contract.js";
import { assessGoalRequirementsFromLocalState } from "../orchestration/goal-requirement-assessment.js";
import { validateGoalContractChange } from "../orchestration/goal-contract.js";
import type { GoalChangeProposer } from "../orchestration/goal-contract.js";
import type { GoalContract } from "../orchestration/goal-contract.js";
import type { GoalGateHydrationResult } from "../orchestration/goal-gate-cache.js";
import { evaluateWorkWindowGate } from "../orchestration/work-window-gate.js";
import { createPauseReasonState } from "../orchestration/work-window-contract.js";
import { evaluateWorkWindowState } from "../orchestration/work-window-contract.js";

import type { GoalDispatchVerdictRecord } from "../orchestration/main-controller.js";
import {
  createWorkWindowTransitionMonitor,
  type WorkWindowTransitionMonitor,
} from "../orchestration/work-window-transition-monitor.js";
import { ExperimentSettingsStore } from "../orchestration/experiment-catalog.js";
import { ToolPackageLifecycleService } from "../toolkit/tool-package-lifecycle-service.js";
import { ToolPackageZipInstaller } from "../toolkit/tool-package-zip-installer.js";
import { ContextClosureCapsuleStore } from "../orchestration/context-closure-capsule-store.js";
import { ContextRecallController } from "../orchestration/context-recall-controller.js";
import { FileContextRecallLedgerStore } from "../orchestration/context-recall-ledger-store.js";
import {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "../orchestration/human-verification-controller.js";
import { ContextNodeLifecycleController } from "../orchestration/context-node-lifecycle.js";
import { ContextRuntimeEventStore } from "../orchestration/context-runtime-event-store.js";
import { GuidanceControlQueue } from "../runtime-guidance/guidance-control-queue.js";
import { GuidanceSourceRegistry } from "../runtime-guidance/runtime-guidance.js";
import { LongToolCheckpointController } from "../runtime-guidance/long-tool-checkpoint.js";
import { GuidanceSubmissionJournal } from "../runtime-guidance/guidance-submission-journal.js";
import { GuidanceChangeIntentController } from "../runtime-guidance/guidance-change-intent.js";
import { FileGuidanceChangeIntentJournal } from "../runtime-guidance/guidance-change-intent-journal.js";
import {
  AccuracyPolicyStore,
  FileAccuracyAttemptJournal,
  FileAccuracyVerificationAuditLog,
} from "../orchestration/accuracy-policy-store.js";
import { LocalPreservationService } from "../orchestration/local-preservation-service.js";
import { AgentEditIntentGuard } from "../orchestration/agent-edit-intent-guard.js";
import {
  RecoveryCheckpointRecorder,
  RecoveryCheckpointWriteQueue,
  RecoveryCheckpointingToolPort,
  buildWritingProcessInstanceIdentifier,
} from "../orchestration/recovery-checkpoint-recorder.js";
import { RecoveryCheckpointStore } from "../orchestration/recovery-checkpoint-store.js";
import { LocalContextGraphStore } from "../orchestration/local-context-graph-store.js";
import {
  createContextPromptProvider,
  type ContextPromptProvider,
  type NecessaryContextCondition,
} from "../orchestration/context-prompt-assembler.js";

export interface ApplicationRuntime {
  controller: MainController;
  missionManager: MissionManager;
  taskStore: TaskStore;
  supervisor: FeedbackProcessSupervisor | null;
  feedbackClient: ForkFeedbackClient | null;
  /** T12-02：跨进程 mission 活动租约（CLI 并发门禁与编排会话共用）。 */
  missionLeaseStore: MissionLeaseStore;
  /** T12-02：本 CLI 进程不可复用实例标识。 */
  processInstanceId: string;
  /** B6R-09：已注册 Agent 目录（报告来源认证的登记入口）。 */
  registeredAgentDirectory: RegisteredAgentDirectory;
  /** T08C-04：项目侦察（只读侦察任务 + PROJECT_CONTEXT_DIGEST_V1 落盘）。 */
  reconnaissanceController: ProjectReconnaissanceController;
  /** T08A：任务序列管理面（发布序列/插入任务/状态流转的本地控制面入口）。 */
  taskSequenceManageController: TaskSequenceManageController;
  /** T07D-07：独立工作助手纵向闭环（场景 A 只读分析 / 场景 B 小型代码任务）。 */
  standaloneWorkflowRunner: StandaloneWorkflowRunner;
  /** 产品入口实际选用的运行时种类（mock/provider）。 */
  runtimeKind: "mock" | "provider";
  /** T04：反馈传输是否为独立进程（false = 进程内 noop），供产品入口/诊断读取。 */
  isFeedbackProcessIndependent: boolean;
  /** T07：是否强制要求版本化完成控制事件（Provider 产品运行时为 true）。 */
  requiresCompletionControlEvent: boolean;
  /** 权威执行结果摘要（来自 Agent 工作存档的 result 条目；T07D-R1-03）。 */
  readMissionResultSummaries: (
    missionId: string,
  ) => Promise<Array<{ taskId: string | null; entryType: string; summary: string }>>;
  /** T09A-R1-02：全局上下文预算策略（CLI/GUI 共用同一权威存储）。 */
  globalContextBudgetStore: GlobalContextBudgetStore;
  scopedSettingsStore: ScopedSettingsStore;
  agentModelBindingStore: AgentModelBindingStore;
  missionRuntimeRegistry: MissionRuntimeRegistry;
  artifactRecordStore: ArtifactRecordStore;
  projectWorkWindowStore: ProjectWorkWindowStore;
  /**
   * 接线缺口第 ④ 项（2026-10-28）：时段变化检测器句柄（宿主可 observeNow 或 rely on 定时器）。
   * 默认不启动；需要 `isWorkWindowResumeMonitorEnabled` 显式开启。
   */
  workWindowTransitionMonitor: WorkWindowTransitionMonitor;
  /** 清单第 ① 项收尾：两套记账差异历史（只读诊断）。 */
  taskLedgerDivergenceJournal: TaskLedgerDivergenceJournal;
  /**
   * 目标模式 R2（2026-10-29）：目标状态存储句柄（只构造，不启动）。
   * 后续轮次用它做解析器、恢复对账与激活校验。
   */
  goalModeStateStore: GoalModeStateStore;
  /** GOAL-02 R3：契约存储（显式控制面写入；解析器只读）。 */
  goalContractStore: GoalContractStore;
  /** GOAL-02 R3：mission ↔ 目标 绑定（只维护映射）。 */
  goalMissionBindingStore: GoalMissionBindingStore;
  /** GOAL-02 R3：门禁缓存（同步解析；启动时 hydrate）。 */
  goalGateCache: GoalGateCache;
  /** GOAL-02 R3：最近一次 hydrate 的结果（还原数 + 跳过原因）。 */
  goalGateHydration: GoalGateHydrationResult;
  /** 计划 R7：完成收据存储（worker 成功分支落盘；严格模式读取）。 */
  completionReceiptStore: CompletionReceiptStore;
  /** 计划 R10：完成裁决存储（读取已接；写入方待 R11）。 */
  completionVerdictStore: CompletionVerdictStore;
  /**
   * GOAL-02 R5：激活目标模式（唯一入口；经 `resolveGoalModeActivation` 判定）。
   * 未调用或判定未通过 ⇒ 门禁解析器恒为 null，目标模式不参与派发/恢复。
   */
  activateGoalMode: (input: {
    readonly isExplicitUserRequest: boolean;
    readonly isAuthenticatedUser: boolean;
    readonly isExplicitlyEnabled: boolean;
    readonly requestedBy: "user" | "model" | "tertiary-agent";
  }) => { readonly isActive: boolean; readonly reason: string };
  /** GOAL-02 R5：当前激活状态（只读）。 */
  getGoalModeActivation: () => { readonly isActive: boolean; readonly reason: string };
  /**
   * GOAL-02 R30：**控制面最小入口**（宿主代码调用；**无 CLI/UI**）。
   *
   * `createGoalContract` 经 `saveActivated`（未激活 ⇒ 抛 `task-sequence-permission-denied`），
   * 成功/绑定/解绑后都会刷新门禁缓存，使解析器立即看到新数据。
   */
  createGoalContract: (input: {
    readonly contract: GoalContract;
    readonly activation: Parameters<typeof resolveGoalModeActivation>[0];
  }) => Promise<{ readonly isActive: boolean; readonly reason: string }>;
  bindMissionToGoal: (input: {
    readonly missionIdentifier: string;
    readonly goalIdentifier: string;
  }) => Promise<{ readonly goalIdentifier: string }>;
  unbindMissionFromGoal: (
    missionIdentifier: string,
  ) => Promise<{ readonly didUnbind: boolean }>;
  /** R36：关闭目标实验（只置标记；关闭后该目标不再还原门禁、不再新增目标派发）。 */
  closeGoalExperiment: (input: {
    readonly goalIdentifier: string;
    readonly reason: string;
  }) => Promise<{ readonly isExperimentClosed: boolean; readonly closedAtIso: string }>;
  /** R71：目标状态视图（无状态 ⇒ null）。 */
  describeGoalStatus: (goalIdentifier: string) => Promise<GoalModeStatusView | null>;
  /** R71：契约变更（合法来源 + revision 校验 + 预算不重置）。 */
  updateGoalContract: (input: {
    readonly contract: GoalContract;
    readonly proposer: GoalChangeProposer;
    readonly activation: Parameters<typeof resolveGoalModeActivation>[0];
  }) => Promise<{ readonly revision: number }>;
  /** R71：目标失活（关闭 + 解绑；历史保留，不删除文件）。 */
  deactivateGoal: (input: {
    readonly goalIdentifier: string;
    readonly reason: string;
  }) => Promise<{ readonly closedAtIso: string; readonly unboundMissionCount: number }>;
  refreshGoalGateCache: () => Promise<GoalGateHydrationResult>;
  experimentSettingsStore: ExperimentSettingsStore;
  toolPackageLifecycleService: ToolPackageLifecycleService;
  toolPackageZipInstaller: ToolPackageZipInstaller;
  /** T09A-R1-04：真实装配事件（指标复算与"下一请求生效"证据）。 */
  contextRuntimeEventStore: ContextRuntimeEventStore;
  /** GUIDE-01-04：运行中指导控制队列（公共入口/CLI 提交与查看状态）。 */
  guidanceControlQueue: GuidanceControlQueue;
  /** GUIDE-01-04：指导提交/应用状态日志（跨进程可读）。 */
  guidanceSubmissionJournal: GuidanceSubmissionJournal;
  /** GUIDE 增量：追加/修订/新建任务的变更意图控制器。 */
  guidanceChangeIntentController: GuidanceChangeIntentController;
  /** GUIDE 增量：变更意图状态日志（跨进程 history/revision 共用）。 */
  guidanceChangeIntentJournal: FileGuidanceChangeIntentJournal;
  /** 认证用户标识（指导来源必须绑定到具体人类个体）。 */
  authenticatedUserId: string | null;
  /** 身份来源：explicit（调用方）/ host（可信宿主用户上下文）/ absent（不可用）。 */
  authenticatedUserSource: "explicit" | "host" | "absent";
  /** 删除备份交互授权端口是否装配（缺端口=协同模式删除被拒，不等待）。 */
  hasBackupDeletionControlPort: boolean;
  /** 安装交互端口是否装配（缺端口=安装被拒，不等待）。 */
  hasInstallationUserPort: boolean;
  /** GUIDE-01-03：长工具检查点与协作取消控制器。 */
  longToolCheckpointController: LongToolCheckpointController;
  /** T09A-R1-03：人工核验（延迟核验任务/签收/否决）。 */
  humanVerificationController: HumanVerificationController;
  /** T09A-R1-03：关闭胶囊存储（裁决时按内容哈希定位所属 mission）。 */
  contextClosureCapsuleStore: ContextClosureCapsuleStore;
  /** T09A-R1-01：本地上下文图存储（裁决按所属 Agent 隔离读取）。 */
  contextGraphStore: LocalContextGraphStore;
  /** 本进程主 Agent 实例标识（延迟核验/追认归属用，不进入前端 DTO）。 */
  mainAgentInstanceId: string;
  /** AUTH-SCOPE-03：显式登记的工程根（范围判定唯一依据）。 */
  registeredProjectRoots: RegisteredProjectRoot[];
  /** AUTH-SCOPE-03：工具执行前的范围授权门禁。 */
  scopeAuthorizationGate: ScopeAuthorizationGate;
  /** ACCURACY-03：档位/预算/开关策略存储（仅认证用户可配置）。 */
  accuracyPolicyStore: AccuracyPolicyStore;
  /** ACCURACY-03：完成签收幂等日志（跨进程，重复派发不重复副作用）。 */
  accuracyAttemptJournal: FileAccuracyAttemptJournal;
  /** ACCURACY-03：逐次校验审计日志（证明关闭时不新增模型审查）。 */
  accuracyVerificationAuditLog: FileAccuracyVerificationAuditLog;
  /** GIT-PRESERVE-02：远端同步失败后的本地保全（工作树之外的受保护快照）。 */
  localPreservationService: LocalPreservationService;
  sessionElevationStore: SessionPermissionElevationStore;
  sessionElevationController: SessionPermissionElevationController;
  shutdown: () => Promise<void>;
}

export interface ApplicationRuntimeOptions {
  missionRuntimePreparer?: (input: {
    missionId: string;
    projectIdentifier: string | null;
    sessionIdentifier: string | null;
    agentInstanceId: string | null;
  }) => Promise<MissionRuntimeLease | null>;
  mode: "ponder" | "assist" | "devolve";
  stateDirectory: string;
  concurrency: number;
  failureThreshold: number;
  maxLoopIterations: number;
  /** 是否启动独立反馈进程（headless 单命令场景可关闭）。 */
  useFeedbackProcess: boolean;
  /**
   * OBS-01／PERF-01-02（2026-11-08，第 83 轮）：是否采集性能样本（缺省 false）。
   *
   * 打开后：工具循环样本经编排层补齐身份 → 追加到 `<stateDirectory>` 下的性能样本文件
   * ⇒ `queryPerfOverview`（CLI/GUI 只读概览）**在生产里真的看得见数据**。
   * **缺省关**是因为本卡要求「观察开销预算**先测再定**」。
   */
  isPerformanceCollectionEnabled?: boolean;
  /**
   * EVENT-01（2026-10-24，用户"按建议做"）：生产事件源默认开启。
   * 传 `false` 可关闭（只影响是否把崩溃/连续 provider 失败升级为事故）。
   */
  isEventControlEnabled?: boolean;
  /**
   * OBS-01／DIAG-01（2026-11-08，第 85 轮）：是否采集诊断事件（缺省 false）。
   *
   * 打开后：工具循环上报的**真实执行失败**经编排层补齐身份 → 追加到状态目录下的
   * 诊断事件文件 ⇒ queryDiagnosticSummary 在生产里**真的看得见数据**。
   * **执行前拒绝与取消不会被上报**（卡内硬约束）。缺省关 ⇒ 不擅自改变生产行为。
   */
  isDiagnosticCollectionEnabled?: boolean;
  /** G2（第 130 轮）：活锁/循环守卫开关。**缺省 false**（不擅自改默认行为）。 */
  isProgressGuardEnabled?: boolean;
  /** G2（第 162 轮）：任务链总调用预算（缺省 undefined ⇒ 200，**默认行为不变**）。 */
  progressGuardTaskTotalCallBudget?: number;
  /** G3（第 133 轮）：高严谨性强制事实验证开关。**缺省 false**（不擅自改默认行为）。 */
  /**
   * ALIGN-01-01（2026-10-28）：**稳定会话身份映射**（缺省启用）。
   *
   * 启用后：带项目标识的用户消息会把 mission 归到该项目的稳定会话与固定主个体，
   * 并把 mission 登记为该会话下的一次运行（`<state>/conversation-identity/`）。
   * 这是 ALIGN 主干的前置（重启恢复、报告归属都依赖它），故**默认开启**；
   * 传 `false` 可回到"不落任何身份映射"的旧行为（无项目标识时两条路径等效）。
   */
  isConversationIdentityEnabled?: boolean;
  /**
   * ALIGN-01-05（2026-10-28）：主 Agent 单条处理预算（毫秒；缺省 180000）。
   * 超期即中止本轮并落库记账，明确回报"待补信息/待继续"。
   */
  mainAgentTurnBudgetMilliseconds?: number;
  /**
   * ALIGN-02-02（2026-10-28）：是否启用**模型背书的任务分解**（缺省 false）。
   *
   * 打开后：assist 收到用户消息时先让规划运行时产出分解候选稿，经本地契约校验后
   * 才写入任务链；校验/规划失败 ⇒ 显式降级为单节点并在摘要标 `single-node-fallback`。
   * **缺省关**：该路径会真实调用模型，而本卡交付口径不运行模型验证，
   * 因此默认保持旧行为（摘要标 `legacy-single-node`）。
   */
  isModelTaskPlanningEnabled?: boolean;
  /**
   * ALIGN-03-03（2026-10-28）：是否要求 **Worker 完成收据** 才判 `done`（缺省 false）。
   *
   * 打开后：`success` 但收据缺失/矛盾 ⇒ 任务置 blocked 并升级原因，不伪造 done。
   * 缺省关：该路径尚未实测，改变默认收口行为会把未验证的判断推给所有任务。
   */
  isCompletionReceiptRequired?: boolean;
  /**
   * ALIGN-04-02（2026-10-28）：恢复前是否启用**只读对账门禁**（缺省 false）。
   *
   * 打开后：`resumeMission` 先经恢复中心只读检查 —— mission 不存在/状态损坏/
   * 检查点声明需对账时**拒绝续接**并给出原因；查看历史不会启动任务。
   */
  isMissionRecoveryGateEnabled?: boolean;
  /**
   * 接线缺口第 ④ 项（2026-10-28）：**时段变化检测器开关**（缺省关）。
   *
   * 开启后每 300s（下限 60s）读一次时段状态；首次只建基线，只在 rest → working 时
   * 调用 `onWorkWindowRestToWorking`。**不自动恢复任务**（是否恢复由宿主决定）。
   */
  isWorkWindowResumeMonitorEnabled?: boolean;
  /** 时段 rest → working 时的宿主回调（收到观测时间；是否恢复由宿主决定）。 */
  onWorkWindowRestToWorking?: (observedAtIso: string) => void | Promise<void>;
  /**
   * 清单第 ⑥ 项（2026-10-28）：目标门禁解析器透传（缺省不参与派发）。
   *
   * 由宿主按 mission 提供 `GoalDispatchGate`；`isGoalModeEnforcementEnabled` 缺省 false ⇒
   * 只观察记录，不改变派发。
   */
  goalDispatchGateResolver?: (missionIdentifier: string) => GoalDispatchGate | null;
  isGoalModeEnforcementEnabled?: boolean;
  /**
   * R51（2026-10-29）：**组性质提供者**（可选）。
   *
   * 只依据本次组将启动的任务标识返回 `normal` / `investigation` / `rework`；
   * 缺省不传 ⇒ 一律 `normal`（调查/返工组不计入停滞检查）。
   */
  goalTaskGroupKindProvider?: (input: {
    readonly taskIdentifiers: readonly string[];
  }) => "normal" | "investigation" | "rework";
  onGoalDispatchVerdict?: (record: GoalDispatchVerdictRecord) => void;
  /**
   * G5（2026-11-08 第 235 轮）：**早停 ⇒ 从检查点有界续跑**（缺省关）。
   * 仅当工具循环明确上报早停、且本任务续跑次数 < 2 时续跑。
   */
  isCheckpointResumeEnabled?: boolean;
  /**
   * G1（2026-11-08 第 255 轮）：**Git 集成**（缺省不启用）。
   * 传入即构造四件套并交给控制器补全（worktree 端口带身份；永不自动合并）。
   */
  gitIntegration?: {
    repositoryPath: string;
    targetBranchName: string;
    /**
     * 收尾第 5 步（2026-10-29）：**合并前是否要求已指定审查者**（缺省 false）。
     *
     * 此前该开关只存在于 `GitIntegrationCoordinatorOptions`，运行时构造协调器时**未透传**，
     * 导致"合并前要求审查者"在产品装配里**不可达**。现在可达，但**默认仍关**。
     */
    isReviewRequiredForMerge?: boolean;
    /**
     * 收尾第 6 步（2026-10-29）：**任务类型 → 允许修改路径**（仓库相对路径）。
     *
     * 此前运行时把它写死为 `{}`（⇒ 任何任务类型都不做 Git 分流）。
     * 现在可配置；**缺省仍为 `{}`**，行为不变。未列出的任务类型不做 Git 分流。
     */
    allowedPathsByTaskType?: Record<string, string[]>;
    /**
     * 收尾第 6 步：**集成测试命令**（在仓库目录以 shell 执行，同时作为贡献的测试证据）。
     *
     * 此前写死为 `[]`（⇒ 不跑任何集成测试）。现在可配置；**缺省仍为 `[]`**。
     */
    integrationTestCommands?: string[];
  };
  /**
   * G4（2026-11-08 第 281 轮）：**工具公开用法登记**（缺省空 ⇒ 不注入任何说明）。
   * 产品**默认不内置**登记内容（examples/limitations 无法从描述符推导，禁止编造）。
   */
  toolDocumentationRegistry?: Record<string, ToolPublicDocumentationRegistryEntry>;
  isHighRigorEnforcementEnabled?: boolean;
  streamOutput: (missionId: string | null, text: string) => void;
  /**
   * GUI-02-01 片①（2026-10-11）：权限询问**携带绝对身份**的上报口（可选）。
   *
   * 未提供时行为与之前**逐字一致**；提供后由 CLI 侧据
   * `ownerAgentInstanceId` 注册 `PermissionAskRequestStore` 的请求实体
   * （该 store 按 `agent-memory/<owner>/permission-ask-requests/` 落盘，故 owner 必填）。
   */
  onPermissionAskWithIdentity?: (input: {
    ownerAgentInstanceId: string;
    taskId: string;
    message: string;
  }) => void;
  /**
   * 权限询问（Assist）：携带工具名与**精确参数**，供宿主登记
   * `PermissionAskRequestStore` 请求实体（GUI 待授权面板的数据来源）。
   */
  onPermissionAsk?: (ask: {
    missionId: string;
    taskId: string;
    toolName: string;
    argumentsJson: string;
    explanation: string;
  }) => void;
  /** 备份删除交互端口（界面层注入；null 表示无交互通道，fail-closed）。 */
  backupDeletionControlPort?: BackupDeletionAuthorizationControlPort | null;
  /** 安装门禁交互端口（界面层注入；null 表示无交互通道，fail-closed）。 */
  installationUserPort?: InstallationGateUserPort | null;
  /** 认证用户标识（可信本地 harness 注入）。 */
  authenticatedUserId?: string | null;
  /** 产品入口实际选用的运行时种类（诊断用；缺省 mock）。 */
  runtimeKind?: "mock" | "provider";
  /** 主 Agent 实例标识（报告/摘要路由用）。 */
  mainAgentInstanceId?: string;
  /** 独立反馈进程入口路径；不传则使用 supervisor 默认解析。 */
  feedbackProcessModulePath?: string | null;
  /** 主 Agent 运行时工厂覆盖（Provider 接线；缺省为 mock ScriptedRuntime）。 */
  mainRuntimeFactory?: (agentInstanceId: string) => AgentRuntime;
  /** Worker 运行时工厂覆盖（Provider 接线；缺省为 mock ScriptedRuntime）。 */
  workerRuntimeFactory?: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  /** T07D-R2-03：Provider 运行时强制要求本地完成控制事件（mock 默认关闭）。 */
  requireCompletionControlEvent?: boolean;
  /** 显式对话模式（GUI 聊天）：无工具/产物时不要求完成控制事件。 */
  isConversationMode?: boolean;
  /** T09A-R1-01：全局上下文预算（token，默认 4096）。 */
  globalContextBudgetTokens?: number;
  /** T09A-R1-01：任务必要条件；不满足时阻塞而非静默执行。 */
  mandatoryContextConditions?: NecessaryContextCondition[];
  /** T09A-R1-01：上下文提示词装配提供者覆盖（测试/嵌入用）。 */
  contextPromptProvider?: ContextPromptProvider;
  /** T09A-R1-02：Provider 可用输入空间（token）；缺省不缩减。 */
  modelInputSpaceTokens?: number | null;
  /** AUTH-SCOPE-03：显式登记的工程根（缺省为创建时 cwd；范围判定不再隐式读 cwd）。 */
  workspaceRootPath?: string;
  /** AUTH-SCOPE-03：登记工程根标识。 */
  projectIdentifier?: string;
  /** AUTH-SCOPE-03：上级批准端口（缺省由本地控制面批准项目内操作）。 */
  scopeSuperiorApprovalPort?: ScopeGateSuperiorApprovalPort;
}

/**
 * 检查点 B：会话级主 Agent 实例身份。
 * 由 state dir 的绝对路径确定性派生：同一会话（同一 state dir）跨进程复用同一身份，
 * 不同会话互不复用；不再使用固定字面量，也不额外落盘（避免绕过破坏性文件 API 守卫）。
 */
function deriveMainAgentInstanceIdFromStateDirectory(stateDirectory: string): string {
  const pathDigest = createHash("sha256")
    .update(path.resolve(stateDirectory))
    .digest("hex");
  return `main-${pathDigest.slice(0, 8)}`;
}

export async function createApplicationRuntime(
  options: ApplicationRuntimeOptions,
): Promise<ApplicationRuntime> {
  const stateDirectory = options.stateDirectory;
  // 检查点 B：主 Agent 实例 ID 不再固定字面量；同一 state dir（同一会话）内跨进程复用，
  // 不同会话（不同 state dir）互不复用。
  const mainAgentInstanceId =
    options.mainAgentInstanceId ??
    deriveMainAgentInstanceIdFromStateDirectory(stateDirectory);
  // 检查点 B：身份绑定——显式提供优先；否则取可信宿主用户上下文；不可用即 null（fail-closed）
  // 显式 null 表示"调用方声明无身份"，不得回退到宿主（否则 fail-closed 失效）。
  const authenticatedUserId =
    options.authenticatedUserId === undefined
      ? resolveHostUserIdentifier()
      : options.authenticatedUserId;
  const authenticatedUserSource: "explicit" | "host" | "absent" =
    authenticatedUserId === null
      ? "absent"
      : options.authenticatedUserId === undefined
        ? "host"
        : "explicit";
  const processInstanceId = `process-${randomUUID()}`;
  const missionLeaseStore = new MissionLeaseStore({ stateDirectory });
  const taskStore = new TaskStore({ baseDirectory: stateDirectory });
  const missionManager = new MissionManager(taskStore, stateDirectory);
  const modeMachine = new ModeMachine(options.mode);
  const sessionManager = new SessionAuthorizationManager();
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  // AUTH-SCOPE-03：范围判定只使用显式登记的工程根，不再隐式读取 cwd。
  const registeredProjectRoots: RegisteredProjectRoot[] = [
    {
      projectIdentifier: options.projectIdentifier ?? "workspace",
      rootPath: options.workspaceRootPath ?? process.cwd(),
    },
  ];
  const workspaceBoundary = new WorkspaceBoundary(
    registeredProjectRoots[0]?.rootPath ?? process.cwd(),
  );
  const temporaryDirectoryPath = path.join(stateDirectory, "temp");

  let supervisor: FeedbackProcessSupervisor | null = null;
  let feedbackClient: ForkFeedbackClient | null = null;
  if (options.useFeedbackProcess) {
    supervisor = new FeedbackProcessSupervisor({
      baseDirectory: stateDirectory,
      modulePath: options.feedbackProcessModulePath ?? undefined,
    });
    feedbackClient = await supervisor.start();
  }

  // T06A：自动备份库与删除授权控制器
  const backupVault = new BackupVault({ baseDirectory: stateDirectory });
  await backupVault.initialize();
  const backupDeletionAuditLog = new BackupDeletionAuditLog(stateDirectory);
  // LINUX-PORT-01：按实际文件系统能力决定大小写比较语义，不按平台猜测（一次探测，多处复用）
  const fileSystemCaseSensitivity = await detectFileSystemCaseSensitivity(stateDirectory);
  // AR-01：受保护存储策略（普通工具不得访问保管库与审计存储）
  const protectedStoragePolicy = new ProtectedStoragePolicy({
    stateDirectoryPath: stateDirectory,
    fileSystemCaseSensitivity,
  });
  // T06B / ADR-0014：本地只读工具策略引擎（searchProjectText / gitReadonlyView 执行前校验；
  // 同时作为 Ponder 只读白名单判定器注入权限裁决，避免"工具已注册却永远失败"）。
  const localToolPolicyEngine = new LocalToolPolicyEngine({
    workspaceBoundary,
    protectedStoragePolicy,
  });
  // T06D / ADR-0016：证据包构建器（无外部依赖；未装配会让 build-evidence-bundle 恒失败）
  const evidenceBundleBuilder = new EvidenceBundleBuilder();
  const permissionDecider = new PermissionDecider(
    modeMachine,
    sessionManager,
    async (decisionInput) => {
      try {
        await localToolPolicyEngine.assertPonderToolExecutionAllowed(decisionInput);
        return true;
      } catch {
        return false;
      }
    },
  );
  // T06C / ADR-0018：敏感内容禁读策略（生产装配必须注入，否则读取守卫放行）
  const sensitiveContentAccessPolicy = new SensitiveContentAccessPolicy({
    fileSystemCaseSensitivity,
  });
  // T07B / ADR-0017：重复读取时间锁账本（生产装配必须注入，否则不登记也不抑制）
  const readSuppressionLedger = new ReadSuppressionLedger({
    fileSystemCaseSensitivity,
  });
  // S5：交互式授权通道（警告→暂停→等待用户决定）；非 TTY 环境 fail-closed
  const backupDeletionControlPort = options.backupDeletionControlPort ?? null;
  const backupDeletionController = new BackupDeletionAuthorizationController({
    mode: () => modeMachine.getCurrentMode(),
    controlPort: backupDeletionControlPort,
    auditLog: backupDeletionAuditLog,
    readCurrentVaultRevision: () => backupVault.getManifestRevision(),
  });
  // T05A：Agent 工作存档
  // T07D-R2-03：结果条目落盘即时入内存索引，避免终态先于存档可见的竞态。
  const inMemoryResultSummariesByMission = new Map<
    string,
    Array<{ taskId: string | null; entryType: string; summary: string }>
  >();
  const workArchiveStore = new AgentWorkArchiveStore({
    baseDirectory: stateDirectory,
    onEntryAppended: ({ missionId, entry }) => {
      if (entry.entryType !== "result" || entry.summary.length === 0) {
        return;
      }
      const existing = inMemoryResultSummariesByMission.get(missionId) ?? [];
      existing.push({
        taskId: entry.taskId,
        entryType: entry.entryType,
        summary: entry.summary,
      });
      inMemoryResultSummariesByMission.set(missionId, existing);
    },
  });

  // B6R-02：T06E 安装门禁（分类器/设置/询问/逐次授权 + 交互端口）
  const installationClassifier = new InstallationOperationClassifier();
  const installationSettingsStore = new AssistInstallationSettingsStore({
    baseDirectory: stateDirectory,
  });
  const installationInquiryController = new ExistingResourceInquiryController(null);
  const installationAuthorizationController =
    new AssistInstallationAuthorizationController({
      settingsStore: installationSettingsStore,
    });
  const installationUserPort = options.installationUserPort ?? null;
  const installationGateGuard = new InstallationGateGuard({
    classifier: installationClassifier,
    inquiryController: installationInquiryController,
    authorizationController: installationAuthorizationController,
    userPort: installationUserPort,
    authenticatedUserId,
    getCurrentMode: () => modeMachine.getCurrentMode(),
  });

  // AUTH-SCOPE-03：工具执行前的范围授权门禁（显式登记根 + 裁决矩阵 + 单次授权/重放保护）。
  const scopeSuperiorApprovalPort: ScopeGateSuperiorApprovalPort =
    options.scopeSuperiorApprovalPort ?? {
      approve: async ({ scopeClass }) => ({
        // 本地控制面作为"有权上级"：只自动批准项目内（S1）操作，其余必须人工。
        isApproved: scopeClass === "S1-project-internal",
        approvedByAgentInstanceId:
          scopeClass === "S1-project-internal" ? "local-superior" : null,
      }),
    };
  const scopeAuthorizationGate = new ScopeAuthorizationGate({
    getMode: () => modeMachine.getCurrentMode(),
    getRegisteredProjectRoots: () =>
      registeredProjectRoots.map((root) => ({ ...root })),
    getConfiguredDecision: () =>
      modeMachine.getCurrentMode() === "devolve" ? "allow" : "ask",
    isInstallationEnabled: () =>
      installationAuthorizationController.isInstallationEnabled(),
    getAuthorizationRevision: () => 1,
    superiorApprovalPort: scopeSuperiorApprovalPort,
  });

  // B6R-03：可配置权限引擎（执行前按当前 profile 快照裁决）
  const permissionCatalog = new PermissionCapabilityCatalog();
  const permissionProfileStore = new PermissionProfileStore({
    baseDirectory: stateDirectory,
    catalog: permissionCatalog,
  });
  const configurablePermissionPolicyEngine = new ConfigurablePermissionPolicyEngine({
    catalog: permissionCatalog,
    profileStore: permissionProfileStore,
  });
  /** 当前权限组引用（可信运行时按模式提供；自定义组由认证设置控制面切换）。 */
  const currentPermissionProfileReference: PermissionProfileReference =
    options.mode === "ponder"
      ? { kind: "builtin", profileId: "ponder" }
      : options.mode === "assist"
        ? { kind: "builtin", profileId: "assist" }
        : { kind: "builtin", profileId: "devolve" };
  // B6R-04b：认证设置控制面（当前权限组选择持久化）
  const currentPermissionSelectionStore = new CurrentPermissionSelectionStore({
    baseDirectory: stateDirectory,
  });
  // B6R-06：主 Agent 永久只读投影 + 会话提升控制面 + 关闭协调器
  const mainAgentReadonlyProjection = new MainAgentReadonlyToolProjection();
  /**
   * ALIGN-01-03（2026-10-28）：主 Agent 工具面的**单一权威**是只读投影。
   *
   * ponder 白名单是它的一部分；若两处漂移（有人在 ponder 名单里加了非只读工具），
   * 装配期直接失败，而不是等模型真的调到写工具才发现。
   */
  const ponderToolNamesOutsideProjection = PONDER_READONLY_TOOL_NAMES.filter(
    (toolName) => !mainAgentReadonlyProjection.isMainAgentToolAllowed(toolName),
  );
  if (ponderToolNamesOutsideProjection.length > 0) {
    throw new DomainError(
      "invalid-task-chain",
      `主 Agent 只读投影缺少 ponder 白名单条目（装配拒绝启动）: ${ponderToolNamesOutsideProjection.join(", ")}`,
    );
  }
  const sessionElevationStore = new SessionPermissionElevationStore({
    baseDirectory: stateDirectory,
  });
  const sessionElevationController = new SessionPermissionElevationController(
    sessionElevationStore,
  );
  const sessionElevationResolver = new EffectiveSecondaryPermissionResolver();
  const sessionExporter = new CurrentPermissionConfigurationExporter();
  const sessionShutdownCoordinator = new SessionShutdownCoordinator({
    elevationStore: sessionElevationStore,
    backupPort: backupVault,
  });
  // B6R-09：Agent 注册目录（报告来源认证）+ 主 Agent 报告索引 + 提案控制面
  const registeredAgentDirectory = new RegisteredAgentDirectory();
  const reportArchiveIngestor = new MainAgentReportArchiveIngestor({
    baseDirectory: stateDirectory,
    sourceAuthenticationPort: {
      verifySource: (input) =>
        Promise.resolve(registeredAgentDirectory.verifyReportSource(input)),
    },
  });
  // 任务序列管理面（发布/插入/状态流转）：装配一次，供提案控制面与只读查询复用。
  const sequenceStoreModule = await import(
    "../orchestration/agent-task-sequence-store.js"
  );
  const sequenceControllerModule = await import(
    "../orchestration/task-sequence-controllers.js"
  );
  const agentTaskSequenceStore = new sequenceStoreModule.AgentTaskSequenceStore({
    baseDirectory: stateDirectory,
  });
  const sequenceManageController =
    new sequenceControllerModule.TaskSequenceManageController(agentTaskSequenceStore);
  /**
   * 接线缺口第 ① 项（2026-10-28）：状态控制面与管里面**共享同一个 store 实例**，
   * 使"两套记账对照"读到同一份序列文件。
   */
  const sequenceStatusController =
    new sequenceControllerModule.TaskSequenceStatusController(agentTaskSequenceStore);
  const conversationTaskInsertionController = new ConversationTaskInsertionController({
    manageController: sequenceManageController,
    authenticatedUserId,
  });
  // B6R-09：次级持续调度循环（生产装配）
  const dispatchRegistry = new UnboundedAgentInstanceRegistry({
    maxConcurrentSlots: 4,
    maxQueueLength: 32,
    /**
     * ALIGN-02-05（2026-10-28）：**不再注入 `() => 0`**。
     * 缺省占用取注册表真实 `running` 实例数（恒 0 = 并发准入永远放行 = 没有资源约束）。
     */
  });
  const secondaryDispatchLoop = new SecondaryContinuousDispatchLoop({
    registry: dispatchRegistry,
    /**
     * ALIGN-02-05：**不再注册 `async () => false` 的桩**。
     * 真实派发端口由 mission 启动方按 mission 注册；未注册时 `runRound`
     * 明确返回 `dispatch-handler-missing`，不伪装成"派发被拒"。
     */
  });
  // B6R-09：三级生命周期控制器（阶段持久化 + 幂等收口；hooks 由编排层注入）
  const tertiaryLifecyclePhaseStore = new FileTertiaryLifecyclePhaseStore(stateDirectory);
  // B6R-09：个体记忆域 + 跨 Agent 附件控制器（Worker 运行时组件；生产装配）
  const agentIndividualMemoryStore = new AgentIndividualMemoryStore({
    baseDirectory: stateDirectory,
  });
  /**
   * ALIGN-03-07（2026-10-28）：**真实收口钩子**（此前是空 hooks ⇒ 每阶段静默记为 `none`）。
   *
   * 先读个体档案（`persisting-checkpoint`）→ 写只含选定附件的移交文件（`writing-handoff`）
   * → Git 资源如实报告（`handling-git-resources`）→ 进程内 Worker 无进程可杀。
   */
  const tertiaryLifecycleController = new TertiaryAgentLifecycleController(
    buildTertiaryLifecycleHooks({
      individualMemoryStore: agentIndividualMemoryStore,
      handoffDirectoryPath: path.join(stateDirectory, "agent-handoffs"),
    }),
    { phaseStore: tertiaryLifecyclePhaseStore },
  );
  const crossAgentAttachmentController = new CrossAgentContextAttachmentController();
  const tertiaryRuntimeComponents = {
    individualMemoryStore: agentIndividualMemoryStore,
    attachmentController: crossAgentAttachmentController,
    lifecycleController: tertiaryLifecycleController,
  };
  // T08C-07：四层路由控制面装配（直投/摘要/侦察/任命裁决/四级；CLI/TUI/GUI 共用）
  const { SmallTaskEligibilityPolicy } = await import(
    "../orchestration/small-task-eligibility-policy.js"
  );
  const { DirectDispatchController } = await import(
    "../orchestration/direct-dispatch-controller.js"
  );
  const { SecondaryUserFacingSummaryController } = await import(
    "../orchestration/secondary-user-facing-summary-controller.js"
  );
  const { ProjectReconnaissanceDigestStore } = await import(
    "../orchestration/project-reconnaissance-digest-store.js"
  );
  const { ProjectReconnaissanceController } = await import(
    "../orchestration/project-reconnaissance-controller.js"
  );
  const { AgentAppointmentRegistry } = await import(
    "../orchestration/agent-appointment-registry.js"
  );
  const { AcceptanceVerdictGate } = await import(
    "../orchestration/acceptance-verdict-gate.js"
  );
  const { QuaternaryLifecycleController } = await import(
    "../orchestration/quaternary-lifecycle-controller.js"
  );
  const { QuaternaryGitBranchPolicy } = await import(
    "../orchestration/quaternary-boundary-guards.js"
  );
  const directDispatchController = new DirectDispatchController({
    authenticatedUserId,
    eligibilityPolicy: new SmallTaskEligibilityPolicy(),
    sequenceManageController,
    doesSecondaryAgentExist: (agentInstanceId) =>
      registeredAgentDirectory.verifyReportSource({
        reportingAgentInstanceId: agentInstanceId,
        missionId: "mission-cli",
        taskBundleId: "bundle-cli",
      }).valid,
  });
  const t08cSummaryController = new SecondaryUserFacingSummaryController({
    authenticatedMainAgentInstanceId: mainAgentInstanceId,
    reportIndexPort: {
      insertSummaryEntry: async () => undefined,
    },
    sourceAuthenticationPort: {
      isRegisteredSecondary: async (agentInstanceId) =>
        registeredAgentDirectory.verifyReportSource({
          reportingAgentInstanceId: agentInstanceId,
          missionId: "mission-cli",
          taskBundleId: "bundle-cli",
        }).valid,
    },
    detailQueryPort: {
      requestDetail: async () => ({ kind: "unknown", reason: "CLI 未连接具体次级" }),
    },
  });
  const reconnaissanceDigestStore = new ProjectReconnaissanceDigestStore({
    baseDirectory: stateDirectory,
  });
  const reconnaissanceController = new ProjectReconnaissanceController({
    digestStore: reconnaissanceDigestStore,
    // T06C/ADR-0018：复用真实敏感内容策略，避免侦察通道与读取通道出现两套判定
    sensitivePathMatchPort: {
      matchSensitivePathName: (filePath) =>
        sensitiveContentAccessPolicy.matchSensitivePathName(filePath),
    },
    sourceAuthenticationPort: {
      // 按侦察摘要的扫描范围（mission）校验来源，不再写死 CLI 会话作用域。
      isRegisteredReconnaissance: async (input) =>
        registeredAgentDirectory.verifyReconnaissanceSource({
          reportingAgentInstanceId: input.agentInstanceId,
          missionId: input.scanningScope,
        }),
    },
  });
  const appointmentRegistry = new AgentAppointmentRegistry();
  const acceptanceVerdictGate = new AcceptanceVerdictGate({
    appointmentRegistry,
  });
  const quaternaryLifecycleController = new QuaternaryLifecycleController({
    isTertiaryAgentActive: () => true,
  });
  const quaternaryGitBranchPolicy = new QuaternaryGitBranchPolicy();
  // 独立工作助手纵向闭环运行器（场景 A 只读分析 / 场景 B 小型代码任务）
  const standaloneWorkflowRunner = new StandaloneWorkflowRunner({
    directDispatchController,
    appointmentRegistry,
    acceptanceVerdictGate,
    summaryController: t08cSummaryController,
    reconnaissanceController,
    reconnaissanceDigestStore,
  });
  const t08cRoutingFacade = {
    directDispatchController,
    secondarySummaryController: t08cSummaryController,
    reconnaissanceController,
    appointmentRegistry,
    acceptanceVerdictGate,
    quaternaryLifecycleController,
    quaternaryGitBranchPolicy,
  };

  const globalDecisionStore = new GlobalDecisionStore({
    baseDirectory: stateDirectory,
  });
  const contextGraphStore = new LocalContextGraphStore({
    baseDirectory: stateDirectory,
  });
  const globalContextBudgetStore = new GlobalContextBudgetStore({
    baseDirectory: stateDirectory,
  });
  const scopedSettingsStore = new ScopedSettingsStore({
    baseDirectory: stateDirectory,
  });
  await scopedSettingsStore.read();
  const agentModelBindingStore = new AgentModelBindingStore({ baseDirectory: stateDirectory });
  const missionRuntimeRegistry = new MissionRuntimeRegistry();
  const artifactRecordStore = new ArtifactRecordStore({ baseDirectory: stateDirectory });
  const projectWorkWindowStore = new ProjectWorkWindowStore({ baseDirectory: stateDirectory });
  /** 清单第 ① 项收尾：两套记账差异历史（只读诊断；只记录不修复）。 */
  const taskLedgerDivergenceJournal = new TaskLedgerDivergenceJournal({
    baseDirectory: stateDirectory,
  });
  /**
   * R21（2026-10-29）：**mission↔序列 持久索引**。
   *
   * 只构造句柄并透传给控制器；写入发生在发布/回填路径，失败不阻断发布。
   * CLI 侧独立构造同一路径的存储来读取（见 `task-ledger status`）。
   */
  const missionSequenceBindingStore = new MissionSequenceBindingStore({
    baseDirectory: stateDirectory,
  });
  /** R24：推迟到下一组的插入队列（控制器入队；消费方在后续检查点）。 */
  const deferredInsertionQueueStore = new DeferredInsertionQueueStore({
    baseDirectory: stateDirectory,
  });
  /**
   * 目标模式 R2（2026-10-29）：**状态存储装配**。
   *
   * 只构造句柄，不启动、不读写、不改变任何派发行为；
   * 后续轮次（R3 解析器 / R4 恢复对账 / R5 激活校验）才接进流程。
   */
  /** R35：目标门禁判定记录（有界 200 条；只记录判定，不含正文）。 */
  const goalDispatchVerdictJournal = new GoalDispatchVerdictJournal({
    baseDirectory: stateDirectory,
  });
  const goalModeStateStore = new GoalModeStateStore({
    baseDirectory: stateDirectory,
  });
  /**
   * 计划 R7（2026-10-29）：**完成收据存储**。
   *
   * 只构造句柄；worker 成功分支提供收据时才落盘（R7），严格模式读取同一份（R8）。
   */
  const completionReceiptStore = new CompletionReceiptStore({
    baseDirectory: stateDirectory,
  });
  /**
   * 计划 R10（2026-10-29）：**完成裁决存储**。
   *
   * 只构造句柄；读取经 `completionVerdictReader`（本文件）。
   * 写入方尚未接（缺少 appointment 的 mission 字段，R11）。
   */
  const completionVerdictStore = new CompletionVerdictStore({
    baseDirectory: stateDirectory,
  });
  /**
   * GOAL-02 R3：门禁解析器的三个只读输入 + 启动时还原缓存。
   *
   * 全部为空（没有契约/绑定/状态）时 `hydrate()` 返回 0 条，解析器恒为 null，
   * **行为与接线前逐字一致**。
   */
  const goalContractStore = new GoalContractStore({ baseDirectory: stateDirectory });
  const goalMissionBindingStore = new GoalMissionBindingStore({
    baseDirectory: stateDirectory,
  });
  const goalGateCache = new GoalGateCache({
    bindingStore: goalMissionBindingStore,
    contractStore: goalContractStore,
    stateStore: goalModeStateStore,
  });
  const goalGateHydration = await goalGateCache.hydrate();
  /**
   * GOAL-02 R5（2026-10-29）：**激活状态**（默认未激活）。
   *
   * 唯一的激活判定是 `resolveGoalModeActivation`（不再有 `GOAL_MODE_DEFAULT_ENABLED` 常量）。
   * 未激活 ⇒ 门禁解析器恒为 null ⇒ 目标模式完全不参与派发/恢复。
   */
  let isGoalModeActivated = false;
  let goalModeActivationReason = "目标模式未激活（默认关闭：需认证用户显式请求并显式开启）。";
  const activateGoalMode = (input: {
    readonly isExplicitUserRequest: boolean;
    readonly isAuthenticatedUser: boolean;
    readonly isExplicitlyEnabled: boolean;
    readonly requestedBy: "user" | "model" | "tertiary-agent";
  }): { readonly isActive: boolean; readonly reason: string } => {
    const activation = resolveGoalModeActivation(input);
    isGoalModeActivated = activation.isActive;
    goalModeActivationReason = activation.reason;
    return activation;
  };
  const getGoalModeActivation = (): {
    readonly isActive: boolean;
    readonly reason: string;
  } => ({ isActive: isGoalModeActivated, reason: goalModeActivationReason });
  /**
   * F 阶段 R30（2026-10-29）：**目标模式控制面最小入口**。
   *
   * 在此之前 R3–R5 的接线**没有任何写入方**：契约/绑定都不存在 ⇒ 解析器恒 null。
   * 这里提供三个宿主侧方法（**无 CLI/UI**）：
   * - `createGoalContract`：经 `saveActivated`，未激活 ⇒ 拒绝落盘；
   * - `bindMissionToGoal`：写入 mission→goal 映射（不改绑，需先 `unbindMissionFromGoal`）；
   * - 两者随后 `refreshGoalGateCache()`，让门禁解析器立即看到新数据。
   * 仍**默认不激活、不阻断**；强制模式仍由 `isGoalModeEnforcementEnabled` 控制（缺省关）。
   */
  const refreshGoalGateCache = async (): Promise<GoalGateHydrationResult> => {
    const hydrationResult = await goalGateCache.hydrate();
    return hydrationResult;
  };
  const createGoalContract = async (input: {
    readonly contract: GoalContract;
    readonly activation: Parameters<typeof resolveGoalModeActivation>[0];
  }): Promise<{ readonly isActive: boolean; readonly reason: string }> => {
    const activation = await goalContractStore.saveActivated(
      input.contract,
      input.activation,
    );
    /**
     * R33（2026-10-29）：**状态初始化**（缺口 1 的第一步）。
     *
     * 此前 `GoalModeStateStore` 没有任何写入方 ⇒ hydrate 恒 `state-missing`。
     * 这里在契约首次落盘后写一条初始状态（`gateSnapshot` 由新建门禁导出），
     * 使"契约 + 绑定 + 状态"三者齐备、`revision` 一致 ⇒ 缓存可还原。
     *
     * 已存在状态 ⇒ **不覆盖**（不重置已累计的组数/预算）。
     */
    const existingState = await goalModeStateStore
      .read(input.contract.goalIdentifier)
      .catch(() => null);
    if (existingState === null) {
      const initialGateSnapshot = new GoalDispatchGate(
        input.contract,
      ).createSnapshot();
      const initialState: PersistedGoalModeState = {
        schemaVersion: GOAL_MODE_STATE_SCHEMA_VERSION,
        documentRevision: 1,
        goalIdentifier: input.contract.goalIdentifier,
        contractRevision: input.contract.revision,
        ownerIdentifier: input.contract.ownerIdentifier,
        sourceRequestReference: input.contract.sourceRequestReference,
        requirementBases: [],
        lastPotentialValue: null,
        currentTaskGroupIdentifier: null,
        currentTaskGroupStartedAtIso: null,
        consumedToolCalls: 0,
        consumedCostUnits: 0,
        pauseReason: null,
        evidenceGaps: [],
        requiresReplanning: false,
        isExperimentClosed: false,
        closedAtIso: null,
        gateSnapshot: initialGateSnapshot,
        updatedAtIso: new Date().toISOString(),
      };
      await goalModeStateStore.write(initialState);
    }
    await refreshGoalGateCache();
    return activation;
  };
  /**
   * R34（2026-10-29）：**目标组开始/结束**的持久化实现。
   *
   * 只在 mission 已绑定目标、契约存在且 revision 一致时写入；
   * `finish` 只清空在途组标记（`gateSnapshot` 原样回写，**不推进 V**）。
   */
  const goalTaskGroupStatePort = {
    begin: async (input: {
      readonly missionIdentifier: string;
      readonly taskGroupIdentifier: string;
      readonly startedAtIso: string;
    }): Promise<void> => {
      const goalIdentifier = await goalMissionBindingStore
        .readGoalIdentifier(input.missionIdentifier)
        .catch(() => null);
      if (goalIdentifier === null) {
        return;
      }
      const [contract, state] = await Promise.all([
        goalContractStore.read(goalIdentifier).catch(() => null),
        goalModeStateStore.read(goalIdentifier).catch(() => null),
      ]);
      if (
        contract === null ||
        state === null ||
        state.contractRevision !== contract.revision
      ) {
        return;
      }
      await goalModeStateStore.beginTaskGroup({
        state,
        taskGroupIdentifier: input.taskGroupIdentifier,
        startedAtIso: input.startedAtIso,
      });
    },
    finish: async (input: {
      readonly missionIdentifier: string;
      readonly taskGroupIdentifier: string;
      readonly outcome: "completed" | "interrupted";
      readonly groupKind: "normal" | "investigation" | "rework";
      readonly finishedAtIso: string;
    }): Promise<void> => {
      const goalIdentifier = await goalMissionBindingStore
        .readGoalIdentifier(input.missionIdentifier)
        .catch(() => null);
      if (goalIdentifier === null) {
        return;
      }
      const [contract, state] = await Promise.all([
        goalContractStore.read(goalIdentifier).catch(() => null),
        goalModeStateStore.read(goalIdentifier).catch(() => null),
      ]);
      if (
        contract === null ||
        state === null ||
        state.contractRevision !== contract.revision ||
        state.currentTaskGroupIdentifier !== input.taskGroupIdentifier
      ) {
        return;
      }
      /**
       * R38（2026-10-29）：**本地 V 计算**（缺口 1 的第二步）。
       *
       * 依据 = mission 链真实状态 + accepted 独立裁决 + 完成收据里的真实工具计数：
       * - 全部要求满足 ⇒ `computeGoalPotential` 给出 V；
       * - 任一要求未映射/未完成/缺裁决 ⇒ 该项 `unverified`（V 不会因此被当作 0）；
       * - 计算失败或门禁不可用 ⇒ **只清在途标记**，不写伪 V、不推进组数。
       */
      let nextGateSnapshot = state.gateSnapshot;
      let nextRequirementBases = state.requirementBases;
      let nextPotentialValue = state.lastPotentialValue;
      let nextConsumedToolCalls = state.consumedToolCalls;
      try {
        const missionStatus = await missionManager.getMissionStatus(
          input.missionIdentifier,
        );
        const missionTasks = missionStatus.taskChain?.tasks ?? [];
        const missionTaskStatusByTaskIdentifier = new Map(
          missionTasks.map((task) => [task.id, task.status]),
        );
        const acceptedVerdictTaskIdentifiers = new Set<string>();
        let receiptToolCallTotal = 0;
        for (const task of missionTasks) {
          if (task.status !== "done") {
            continue;
          }
          const verdictRecord = await completionVerdictStore
            .read(input.missionIdentifier, task.id)
            .catch(() => null);
          if (verdictRecord !== null && verdictRecord.verdict === "accepted") {
            acceptedVerdictTaskIdentifiers.add(task.id);
          }
          const receipt = await completionReceiptStore
            .read(input.missionIdentifier, task.id)
            .catch(() => null);
          if (receipt !== null && Number.isFinite(receipt.toolCallCount)) {
            receiptToolCallTotal += Math.max(0, Math.trunc(receipt.toolCallCount));
          }
        }
        const assessments = assessGoalRequirementsFromLocalState({
          contract,
          missionTaskStatusByTaskIdentifier,
          taskIdentifiersWithAcceptedVerdict: acceptedVerdictTaskIdentifiers,
        });
        const potentialResult = computeGoalPotential({ contract, assessments });
        const gate = goalGateCache.resolve(input.missionIdentifier);
        if (potentialResult.status === "computed" && gate !== null) {
          gate.recordToolCallConsumed(
            Math.max(0, receiptToolCallTotal - state.consumedToolCalls),
          );
          gate.recordGroupCompletion({
            groupIdentifier: input.taskGroupIdentifier,
            outcome: input.outcome,
            groupKind: input.groupKind,
            potentialValueAfterGroup: potentialResult.potentialValue,
            recordedBy: "local-verifier",
            recordedAtIso: input.finishedAtIso,
          });
          nextGateSnapshot = gate.createSnapshot();
          nextRequirementBases = potentialResult.assessments.map((assessment) => ({
            requirementIdentifier: assessment.requirementIdentifier,
            weight: assessment.weight,
            evidence: assessment.evidence,
            remainingContribution: assessment.remainingContribution,
          }));
          nextPotentialValue = potentialResult.potentialValue;
          nextConsumedToolCalls = receiptToolCallTotal;
        }
      } catch {
        /** V 计算失败 ⇒ 不写伪值；下面仍只清在途标记。 */
      }
      await goalModeStateStore.finishTaskGroup({
        state,
        finishedAtIso: input.finishedAtIso,
        gateSnapshot: nextGateSnapshot,
        requirementBases: nextRequirementBases,
        lastPotentialValue: nextPotentialValue,
        consumedToolCalls: nextConsumedToolCalls,
      });
    },
  };
  const bindMissionToGoal = async (input: {
    readonly missionIdentifier: string;
    readonly goalIdentifier: string;
  }): Promise<{ readonly goalIdentifier: string }> => {
    await goalMissionBindingStore.bind({
      missionIdentifier: input.missionIdentifier,
      goalIdentifier: input.goalIdentifier,
      boundAtIso: new Date().toISOString(),
    });
    await refreshGoalGateCache();
    return { goalIdentifier: input.goalIdentifier };
  };
  /**
   * R36（2026-10-29）：**关闭目标实验**。
   *
   * 只置关闭标记（保留任务/历史/限制/已执行结果），随后刷新缓存：
   * 关闭的目标不再还原门禁 ⇒ 解析器对它返回 null ⇒ **不再新增目标派发**。
   * 已有任务与状态不受影响；没有任何"静默删除"。
   */
  /**
   * R71（2026-10-30）：**目标状态视图**（K9 接线）。
   *
   * `GoalModeStateStore.describeStatus` 此前**零调用方**；这里暴露给宿主/CLI 作为唯一事实来源。
   * 返回 `null` 表示没有该目标的状态（不伪造）。
   */
  /**
   * R71（2026-10-30）：**目标失活（K8 接线）**。
   *
   * "移除目标"在本仓库的语义是**失活**：置关闭标记 + 解绑所有 mission + 刷新门禁缓存，
   * 使该目标**不再参与派发**；契约/状态/判定记录**全部保留**（卡 03 明确禁止清除历史与限制）。
   * 不做文件删除 —— 真正删除属于产品决定，且会与卡冲突。
   */
  const deactivateGoal = async (input: {
    readonly goalIdentifier: string;
    readonly reason: string;
  }): Promise<{ readonly closedAtIso: string; readonly unboundMissionCount: number }> => {
    const closed = await closeGoalExperiment({
      goalIdentifier: input.goalIdentifier,
      reason: input.reason,
    });
    let unboundMissionCount = 0;
    const bindings = await goalMissionBindingStore.list().catch(() => []);
    for (const binding of bindings) {
      if (binding.goalIdentifier !== input.goalIdentifier) {
        continue;
      }
      const didUnbind = await goalMissionBindingStore
        .unbind(binding.missionIdentifier)
        .catch(() => false);
      if (didUnbind) {
        unboundMissionCount += 1;
      }
    }
    await refreshGoalGateCache();
    return { closedAtIso: closed.closedAtIso, unboundMissionCount };
  };
  /**
   * R71（2026-10-30）：**契约变更（K3 接线）**。
   *
   * - 只接受 `source-publisher` / `authenticated-owner`；模型/三级 Agent 一律拒绝；
   * - 校验 revision 严格 +1、supersedes 指向上一版、标识/所有者/来源引用不变、总权重不变；
   * - **累计预算不重置**（保留 `consumedToolCalls`/`consumedCostUnits`）；
   * - V 依据作废（`requiresReplanning: true` + 证据缺口），因为旧证据绑定旧 revision。
   */
  const updateGoalContract = async (input: {
    readonly contract: GoalContract;
    readonly proposer: GoalChangeProposer;
    readonly activation: Parameters<typeof resolveGoalModeActivation>[0];
  }): Promise<{ readonly revision: number }> => {
    const previousContract = await goalContractStore
      .read(input.contract.goalIdentifier)
      .catch(() => null);
    if (previousContract === null) {
      throw new DomainError(
        "mission-not-found",
        `目标 ${input.contract.goalIdentifier} 没有现存契约，无法变更（请先创建）。`,
      );
    }
    const changeValidation = validateGoalContractChange({
      previousContract,
      nextContract: input.contract,
      proposer: input.proposer,
    });
    if (!changeValidation.isAllowed) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `目标契约变更被拒: ${changeValidation.reasons.join("；")}`,
      );
    }
    await goalContractStore.saveActivated(input.contract, input.activation);
    const previousState = await goalModeStateStore
      .read(input.contract.goalIdentifier)
      .catch(() => null);
    if (previousState !== null && previousState.contractRevision !== previousContract.revision) {
      throw new DomainError(
        "journal-corrupted",
        `状态 revision ${String(previousState.contractRevision)} 与当前契约 ${String(previousContract.revision)} 不一致：先对账再变更。`,
      );
    }
    const baseSnapshot = new GoalDispatchGate(input.contract).createSnapshot();
    const nextState: PersistedGoalModeState = {
      schemaVersion: GOAL_MODE_STATE_SCHEMA_VERSION,
      documentRevision: (previousState?.documentRevision ?? 0) + 1,
      goalIdentifier: input.contract.goalIdentifier,
      contractRevision: input.contract.revision,
      ownerIdentifier: input.contract.ownerIdentifier,
      sourceRequestReference: input.contract.sourceRequestReference,
      /** 旧证据绑定旧 revision ⇒ 作废；累计预算按卡要求保留。 */
      requirementBases: [],
      lastPotentialValue: null,
      currentTaskGroupIdentifier: previousState?.currentTaskGroupIdentifier ?? null,
      currentTaskGroupStartedAtIso: previousState?.currentTaskGroupStartedAtIso ?? null,
      consumedToolCalls: previousState?.consumedToolCalls ?? 0,
      consumedCostUnits: previousState?.consumedCostUnits ?? 0,
      pauseReason: previousState?.pauseReason ?? null,
      evidenceGaps: ["契约已变更为新 revision：需按新契约重新评估（旧证据不适用于新版本）。"],
      requiresReplanning: true,
      isExperimentClosed: previousState?.isExperimentClosed ?? false,
      closedAtIso: previousState?.closedAtIso ?? null,
      gateSnapshot: {
        ...baseSnapshot,
        completedGroupCount: previousState?.gateSnapshot.completedGroupCount ?? 0,
        consumedToolCalls: previousState?.consumedToolCalls ?? 0,
      },
      updatedAtIso: new Date().toISOString(),
    };
    await goalModeStateStore.write(nextState);
    await refreshGoalGateCache();
    return { revision: input.contract.revision };
  };
  const describeGoalStatus = async (
    goalIdentifier: string,
  ): Promise<GoalModeStatusView | null> =>
    await goalModeStateStore
      .describeStatus(goalIdentifier)
      .catch(() => null);
  const closeGoalExperiment = async (input: {
    readonly goalIdentifier: string;
    readonly reason: string;
  }): Promise<{ readonly isExperimentClosed: boolean; readonly closedAtIso: string }> => {
    const closedAtIso = new Date().toISOString();
    await goalModeStateStore.closeExperiment({
      goalIdentifier: input.goalIdentifier,
      closedAtIso,
      reason: input.reason,
    });
    await refreshGoalGateCache();
    return { isExperimentClosed: true, closedAtIso };
  };
  const unbindMissionFromGoal = async (
    missionIdentifier: string,
  ): Promise<{ readonly didUnbind: boolean }> => {
    const didUnbind = await goalMissionBindingStore.unbind(missionIdentifier);
    await refreshGoalGateCache();
    return { didUnbind };
  };
  /**
   * GOAL-02 R4（2026-10-29）：**恢复前的目标模式对账**。
   *
   * 未绑定目标 ⇒ `resume`（不参与）；绑定但契约缺失 ⇒ `stay-paused`（不无契约运行）；
   * 有状态 ⇒ 用 `evaluateResume`：在途组 ⇒ `reconcile-first`，暂停/需重规划 ⇒ `stay-paused`。
   */
  const missionGoalResumeReconciliation = async (
    missionIdentifier: string,
  ): Promise<{
    readonly outcome: "resume" | "reconcile-first" | "stay-paused";
    readonly detail: string;
    readonly evidenceGaps?: readonly string[];
  }> => {
    const goalIdentifier = await goalMissionBindingStore
      .readGoalIdentifier(missionIdentifier)
      .catch(() => null);
    if (goalIdentifier === null) {
      return {
        outcome: "resume",
        detail: "该 mission 未绑定目标：目标模式不参与恢复对账。",
      };
    }
    const contract = await goalContractStore.read(goalIdentifier).catch(() => null);
    if (contract === null) {
      return {
        outcome: "stay-paused",
        detail: `绑定目标 ${goalIdentifier} 的契约缺失或非法：拒绝恢复（不在无契约状态下续接）。`,
        evidenceGaps: ["contract-missing"],
      };
    }
    const decision = await goalModeStateStore.evaluateResume({
      goalIdentifier,
      contract,
    });
    if (decision.kind === "resume") {
      return { outcome: "resume", detail: decision.detail };
    }
    if (decision.kind === "reconcile-first") {
      return {
        outcome: "reconcile-first",
        detail: decision.detail,
        evidenceGaps: [decision.inFlightTaskGroupIdentifier],
      };
    }
    return {
      outcome: "stay-paused",
      detail: decision.detail,
      evidenceGaps: decision.evidenceGaps,
    };
  };
  /**
   * 接线缺口第 ④ 项（2026-10-28）：**时段变化检测器**。
   *
   * 默认关闭（`isWorkWindowResumeMonitorEnabled !== true` ⇒ 不排定时器）；
   * 首次观测只建基线；只在 rest → working 时回调一次。
   * 未提供 `onWorkWindowRestToWorking` 时只记录观察结果，**不偷偷恢复任务**。
   */
  const workWindowTransitionMonitor = createWorkWindowTransitionMonitor({
    timerPort: {
      setInterval: (callback: () => void, intervalMilliseconds: number) =>
        setInterval(callback, intervalMilliseconds),
      clearInterval: (handle: unknown) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    },
    isEnabled: options.isWorkWindowResumeMonitorEnabled === true,
    readCurrentState: async (instantIso: string) =>
      evaluateWorkWindowState({
        instantIso,
        rules: await projectWorkWindowStore.readRules(),
      }).state,
    ...(options.onWorkWindowRestToWorking === undefined
      ? {}
      : {
          onRestToWorking: (observation: {
            readonly observedAtIso: string;
          }): void => {
            void options.onWorkWindowRestToWorking?.(observation.observedAtIso);
          },
        }),
  });
  workWindowTransitionMonitor.start();
  const experimentSettingsStore = new ExperimentSettingsStore({ baseDirectory: stateDirectory });
  const toolPackageLifecycleService = new ToolPackageLifecycleService({ baseDirectory: stateDirectory });
  const toolPackageZipInstaller = new ToolPackageZipInstaller({ baseDirectory: stateDirectory });
  // T09A-R1-03：任务完成后的节点收口（节点 → 验证 → 关闭/等待 → 胶囊 → 核验任务）。
  const contextClosureCapsuleStore = new ContextClosureCapsuleStore({
    baseDirectory: stateDirectory,
  });
  /**
   * ALIGN-04-05（2026-10-28）：**胶囊 → 回访**的真实消费者。
   *
   * 此前胶囊只被写入、从未被读回；这里按调用者构造回访控制器（每个调用者独立账本，
   * 冷却/任务级预算互不干扰），使"按节点关闭/回访重建上下文"可达。
   */
  const contextRecallControllerFactory = (
    callerAgentInstanceId: string,
  ): ContextRecallController =>
    new ContextRecallController({
      capsuleStore: contextClosureCapsuleStore,
      ledgerPort: new FileContextRecallLedgerStore({
        baseDirectory: stateDirectory,
        callerAgentInstanceId,
      }),
    });
  const humanVerificationController = new HumanVerificationController({
    baseDirectory: stateDirectory,
    graphStore: contextGraphStore,
    globalDecisionStore,
  });
  const humanVerificationPolicyStore = new HumanVerificationPolicyStore({
    baseDirectory: stateDirectory,
  });
  const contextNodeLifecycle = new ContextNodeLifecycleController({
    graphStore: contextGraphStore,
    capsuleStore: contextClosureCapsuleStore,
    humanVerificationController,
    humanVerificationPolicyStore,
  });
  const contextRuntimeEventStore = new ContextRuntimeEventStore({
    baseDirectory: stateDirectory,
  });
  const contextPromptProvider =
    options.contextPromptProvider ??
    createContextPromptProvider({
      globalDecisionStore,
      graphStore: contextGraphStore,
      maximumGlobalContextTokenCount: options.globalContextBudgetTokens ?? 4096,
      mandatoryConditions: options.mandatoryContextConditions,
      budgetPolicyProvider: async (input) => {
        const globalPolicy = await globalContextBudgetStore.readPolicy();
        const scoped = await scopedSettingsStore.read();
        const missionSummary = await missionManager.readSummary(input.missionId).catch(() => null);
        const projectIdentifier = missionSummary?.projectIdentifier ?? null;
        const projectContext = projectIdentifier === null
          ? undefined
          : scoped.projects[projectIdentifier]?.context;
        const sessionContext = scoped.sessions[input.missionId]?.context;
        const override = sessionContext ?? projectContext;
        if (override === undefined) return globalPolicy;
        return {
          configuredMaximumGlobalContextTokenCount:
            override.configuredMaximumGlobalContextTokenCount,
          globalContextBudgetPolicyRevision:
            globalPolicy.globalContextBudgetPolicyRevision + scoped.revision,
        };
      },
      modelInputSpaceTokens: options.modelInputSpaceTokens,
      runtimeEventSink: (event) => contextRuntimeEventStore.append(event),
    });

  // GUIDE-01-04：运行中指导控制队列与长工具检查点（来源由本地控制面注册，模型无法注入）。
  const guidanceSourceRegistry = new GuidanceSourceRegistry();
  // 检查点 B：无可信身份时不注册"认证用户"来源——该来源的指导提交将直接不被受理。
  if (authenticatedUserId !== null) {
    guidanceSourceRegistry.register({
      sourceKind: "authenticated-user",
      sourceIdentifier: authenticatedUserId,
      maximumBehaviorTier: "gate-and-request-pause",
      registeredAtIso: new Date().toISOString(),
    });
  }
  guidanceSourceRegistry.register({
    sourceKind: "file-task-observation",
    sourceIdentifier: "local-observation",
    maximumBehaviorTier: "safe-point-guidance",
    registeredAtIso: new Date().toISOString(),
  });
  const guidanceSubmissionJournal = new GuidanceSubmissionJournal({
    baseDirectory: stateDirectory,
  });
  const guidanceControlQueue = new GuidanceControlQueue({
    sourceRegistry: guidanceSourceRegistry,
    // 状态回写为 best-effort：提交由公共入口显式 await 落盘（此处跳过 queued，
    // 否则会在提交写盘尚未完成时用空文档回写而丢条目）。
    onStatusChanged: (entry) => {
      if (entry.status === "queued") {
        return;
      }
      void guidanceSubmissionJournal
        .upsertEntry({
          guidanceIdentifier: entry.guidanceIdentifier,
          guidanceRevision: entry.guidanceRevision,
          behaviorTier: entry.behaviorTier,
          missionIdentifier: entry.missionIdentifier,
          taskIdentifier: entry.taskIdentifier,
          status: entry.status,
          submittedAtIso: entry.submittedAtIso,
          appliedAtIso: entry.appliedAtIso,
          latencyMilliseconds: entry.latencyMilliseconds,
          dropReason: entry.dropReason,
          isApplicationStatusKnown: true,
        })
        .catch(() => {});
    },
  });
  const longToolCheckpointController = new LongToolCheckpointController();
  // GUIDE 增量（用户文档 §6）：追加/修订/新建任务的变更意图与任务 revision。
  const guidanceChangeIntentJournal = new FileGuidanceChangeIntentJournal({
    baseDirectory: stateDirectory,
  });
  const guidanceChangeIntentController = new GuidanceChangeIntentController();
  const persistedChangeIntentState = await guidanceChangeIntentJournal.read();
  if (persistedChangeIntentState !== null) {
    guidanceChangeIntentController.hydrate(persistedChangeIntentState);
  }

  // ACCURACY-03：准确性档位/预算/开关策略、幂等日志与校验审计（产品入口与 CLI 共用）。
  const accuracyPolicyStore = new AccuracyPolicyStore({ baseDirectory: stateDirectory });
  const accuracyAttemptJournal = new FileAccuracyAttemptJournal({
    baseDirectory: stateDirectory,
  });
  const accuracyVerificationAuditLog = new FileAccuracyVerificationAuditLog({
    baseDirectory: stateDirectory,
  });

  // E2E-01-03 S2b：恢复检查点写入者（按 mission+agent 复用同一记录器以维持哈希链）。
  const recoveryCheckpointStore = new RecoveryCheckpointStore({
    baseDirectory: stateDirectory,
  });
  const recoveryCheckpointRecorderByKey = new Map<string, RecoveryCheckpointRecorder>();
  /**
   * **跨记录器共享写队列**（2026-10-07 真实回归修复）：同一 store 被多个记录器共用
   * （键为 `missionId::agentInstanceId`）；不串行化会让"读最新 → 写入"互相插入，
   * `writeCheckpoint` 抛"检查点哈希链断裂"，装饰器在 `started` 阶段 fail-closed。
   */
  const recoveryCheckpointWriteQueue = new RecoveryCheckpointWriteQueue();
  const recoveryProcessInstanceIdentifier = buildWritingProcessInstanceIdentifier({
    processId: process.pid,
    startedAtIso: new Date().toISOString(),
  });
  const mutatingToolNamesForRecovery = new Set([
    "createProjectFile",
    "replaceFileContent",
    "writeFileTemporary",
    "backupVault",
    "deleteBackup",
  ]);
  const buildRecoveryCheckpointingToolPort = (input: {
    missionId: string;
    task: TaskDependencyNode;
    agentInstanceId: string;
    innerToolPort: ToolPort;
  }): ToolPort => {
    const recorderKey = `${input.missionId}::${input.agentInstanceId}`;
    let recorder = recoveryCheckpointRecorderByKey.get(recorderKey);
    if (recorder === undefined) {
      recorder = new RecoveryCheckpointRecorder({
        store: recoveryCheckpointStore,
        sessionIdentifier: input.missionId,
        missionIdentifier: input.missionId,
        taskChainIdentifier: input.task.id,
        writingProcessInstanceIdentifier: recoveryProcessInstanceIdentifier,
        sharedWriteQueue: recoveryCheckpointWriteQueue,
        /**
         * 快照只提供**当前确知**的部分；其余字段取保守值并在此如实说明
         * （不得让未接线的字段冒充已对账状态）：
         *  - `taskNodes`：用本次实际派发的任务节点（状态 `running`）；
         *  - `agentIdentities`：用本次实际的 agentInstanceId（三级执行者）；
         *  - `providerRequests`：留空——Provider 停止确认状态尚未接入检查点；
         *  - `permissionRecovery`：留空——权限公开引用尚未接入，分类侧会因此要求重新授权
         *    （保守方向：宁可要求重新授权，也不假装授权仍然有效）；
         *  - `feedbackCursor` / `workingSetFileCountsByAgent` / `taskChainCumulativeSourceCount`：
         *    取 0——这些游标尚未接入检查点。
         */
        snapshotProvider: () => ({
          agentIdentities: [
            {
              agentInstanceId: input.agentInstanceId,
              agentRole: "tertiary",
              lifecycleState: "active",
              handoffReference: null,
              parentAgentInstanceId: null,
            },
          ],
          taskNodes: [
            {
              taskNodeIdentifier: input.task.id,
              status: "running",
              predecessorTaskNodeIdentifiers: [...input.task.dependsOn],
              priorityTier: 0,
              assignedAgentInstanceId: input.agentInstanceId,
              checkpointIdentifier: null,
              completionAttemptIdentifier: null,
            },
          ],
          humanChangeObservationRevision: 0,
          pendingConflictIdentifiers: [],
          providerRequests: [],
          feedbackCursor: { enqueueCursor: 0, deliveryCursor: 0, ackCursor: 0 },
          permissionRecovery: [],
          workingSetFileCountsByAgent: {},
          taskChainCumulativeSourceCount: 0,
          gateStates: {
            testingGate: "pending",
            acceptanceGate: "pending",
            humanReviewGate: "pending",
            installationGate: "pending",
            backupDeletionGate: "pending",
          },
        }),
      });
      recoveryCheckpointRecorderByKey.set(recorderKey, recorder);
    }
    return new RecoveryCheckpointingToolPort({
      innerToolPort: input.innerToolPort,
      recorder,
      isMutatingTool: (toolName) => mutatingToolNamesForRecovery.has(toolName),
    });
  };

  // GIT-PRESERVE-02：远端同步失败后的本地保全服务（网络失败立即保全，不等待重试耗尽）。
  const localPreservationService = new LocalPreservationService({
    baseDirectory: stateDirectory,
  });

  // E2E-01-03 S1 / T05D-03：Agent 编辑意图与陈旧写入强制（按状态目录持久化基线）。
  const agentEditIntentGuard = new AgentEditIntentGuard({
    baseDirectory: stateDirectory,
  });

  // T06B/ADR-0014：策略包装器（worker 任务端口与思索模式只读端口共用同一套安全端口）。
  const createPolicyWrapperForAgent = (input: {
    agentInstanceId: string;
    allowedToolNames: Set<string>;
    factVerificationClaimIdentifier: string | null;
    taskExecutionId: string | null;
    /** 可配置权限组仅适用于次级 Agent；思索模式白名单由执行层（本地策略引擎）覆盖。 */
    useConfigurablePermissionProfileEngine: boolean;
    /** 可选：本任务的执行根（GUI 多项目）；缺省用启动工作区（旧行为不变）。 */
    workspaceRootPath?: string;
    /** 本任务所属项目（用于读取该项目的文件夹授权并扩展边界）。 */
    projectIdentifier?: string;
    missionIdentifier?: string;
    taskIdentifier?: string;
  }): PolicyWrapper => {
    const folderGrantStore = new FolderGrantStore({ baseDirectory: stateDirectory });
    const taskWorkspaceBoundary =
      input.workspaceRootPath === undefined
        ? workspaceBoundary
        : new WorkspaceBoundary(input.workspaceRootPath, {
            // 用户口径 A：本项目已授权的文件夹**扩展**本任务的工具边界。
            additionalRootsProvider: async () => {
              if (input.projectIdentifier === undefined) return [];
              const outcome = await folderGrantStore.read(input.projectIdentifier);
              if (outcome.kind !== "valid") return [];
              const nowIso = new Date().toISOString();
              return outcome.collection.grants
                .filter((grant) => !grant.isRevoked)
                .filter(
                  (grant) =>
                    grant.expiresAtIso === null ||
                    Date.parse(grant.expiresAtIso) > Date.parse(nowIso),
                )
                .map((grant) => grant.normalizedRootPath);
            },
          });
    const scopedPermission =
      input.projectIdentifier === undefined
        ? undefined
        : scopedSettingsStore.getCached().projects[input.projectIdentifier]?.permission;
    let effectivePermissionProfileReference: PermissionProfileReference =
      currentPermissionProfileReference;
    if (scopedPermission?.permissionProfileId != null) {
      const isBuiltin = (["ponder", "assist", "devolve"] as const).includes(
        scopedPermission.permissionProfileId as "ponder" | "assist" | "devolve",
      );
      effectivePermissionProfileReference = isBuiltin
        ? {
            kind: "builtin",
            profileId: scopedPermission.permissionProfileId as "ponder" | "assist" | "devolve",
          }
        : { kind: "custom", profileId: scopedPermission.permissionProfileId };
    }
    return new PolicyWrapper({
      permissionDecider,
      registry,
      workspaceBoundary: taskWorkspaceBoundary,
      temporaryDirectoryPath,
      workerAllowedToolNames: input.allowedToolNames,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => modeMachine.getCurrentMode(),
      auditSink: undefined,
      backupServicePort: backupVault,
      vault: backupVault,
      deletionController: backupDeletionController,
      requestingAgentInstanceId: input.agentInstanceId,
      protectedStoragePolicy,
      sensitiveContentAccessPolicy,
      /** SEC-02-03（2026-10-28）：生产装配要求敏感策略存在，缺失即拒绝读取。 */
      requireSensitiveContentPolicy: true,
      readSuppressionLedger,
      localToolPolicyEngine,
      ponderGitRepositoryPath: taskWorkspaceBoundary.getWorkspaceRoot(),
      evidenceBundleBuilder,
      factVerificationClaimIdentifier: input.factVerificationClaimIdentifier,
      onProducedArtifacts: async (artifacts) => {
        if (input.missionIdentifier === undefined || input.taskIdentifier === undefined) return;
        for (const artifact of artifacts) {
          await artifactRecordStore.register({
            projectIdentifier: input.projectIdentifier ?? "workspace",
            missionIdentifier: input.missionIdentifier,
            taskIdentifier: input.taskIdentifier,
            sourceAgentInstanceId: input.agentInstanceId,
            artifactType: artifact.artifactType,
            displayName: artifact.displayName,
            location: artifact.path,
          }).catch(() => undefined);
        }
      },
      workWindowGateProvider:
        input.missionIdentifier === undefined
          ? undefined
          : async () => {
              const workWindowRules = await projectWorkWindowStore.readRules(
                input.projectIdentifier ?? undefined,
              );
              const decision = evaluateWorkWindowGate({
                gatePoint: "tool-execution",
                nowIso: new Date().toISOString(),
                rules: workWindowRules,
                pauseReasonState: createPauseReasonState(),
              });
              return decision.kind === "allow"
                ? { isAllowed: true, reason: decision.reason }
                : { isAllowed: false, reason: decision.reason };
            },
      installationGateGuard,
      taskExecutionId: input.taskExecutionId,
      /**
       * E2E-01-03 S1：把"读取时基线 → 写入前比对"接进产品工具路径。
       * 状态目录由装配层掌握，故在此构造（与 readSuppressionLedger 同一注入方式）。
       */
      agentEditIntentGuard,
      configurablePermissionPolicyEngine: input.useConfigurablePermissionProfileEngine
        ? configurablePermissionPolicyEngine
        : null,
      currentPermissionProfileReference: input.useConfigurablePermissionProfileEngine
        ? effectivePermissionProfileReference
        : null,
    });
  };

  /**
   * OBS-01／PERF-01-02（2026-11-08，第 83 轮）：**把性能采集接进生产装配**。
   *
   * 此前该链路从未接线：`perfSampleSink` 只在 `runtime/tool-loop.ts` 声明、只有测试传过，
   * `PerfEventStore` 在生产里只被构造用于**查询** ⇒ `queryPerfOverview` 恒空
   * （属"组件存在但产品不可达"）。此处按开关构造样本落库端口，
   * **身份/任务由编排层补齐**（本层只知道状态目录）。
   *
   * **缺省关**：本卡要求「观察开销预算**先测再定**」，
   * 故不在未测量开销的情况下默认打开"每次工具调用追加一行"的行为。
   */
  let performanceSampleSequence = 0;
  const perfEventStore = options.isPerformanceCollectionEnabled === true
    ? new PerfEventStore({ baseDirectory: options.stateDirectory })
    : null;
  const perfSamplePort =
    perfEventStore === null
      ? undefined
      : async (sample: {
          sourceAgentInstanceId: string;
          missionIdentifier: string;
          taskIdentifier: string;
          operationKind: string;
          durationMilliseconds: number;
          outcome: "success" | "failure" | "cancelled" | "unknown";
        }): Promise<void> => {
          performanceSampleSequence += 1;
          try {
            await perfEventStore.append({
              observeEventVersion: 1,
              eventType: "perf",
              recordedAtIso: new Date().toISOString(),
              sourceAgentInstanceId: sample.sourceAgentInstanceId,
              missionIdentifier: sample.missionIdentifier,
              taskIdentifier: sample.taskIdentifier,
              // 请求级标识：同一进程内唯一且可读（跨重启不保证稳定，见类型注释）
              requestIdentifier:
                sample.missionIdentifier +
                ":" +
                sample.taskIdentifier +
                ":" +
                sample.operationKind +
                ":" +
                String(performanceSampleSequence),
              requestRevision: 1,
              origin: { kind: "system" },
              operationKind: sample.operationKind,
              durationMilliseconds: sample.durationMilliseconds,
              outcome: sample.outcome,
            });
          } catch {
            /**
             * **观测失败不得阻塞业务**（与 `perfSampleSink` 的既定纪律一致；
             * 运行时的既有注释亦如此要求）⇒ 吞掉并继续，不改变任务结果。
             */
          }
        };

  /**
   * OBS-01／DIAG-01（2026-11-08，第 85 轮）：**把诊断采集接进生产装配**。
   *
   * 此前与 PERF 同类：生产里**无人构造 `DiagnosticEvent`**，store 只在 CLI/GUI 被构造
   * **用于查询** ⇒ `queryDiagnosticSummary` 恒"不可报告"。
   * 此处按开关构造落库端口；**身份/任务由编排层补齐**。
   * **只在真实执行失败时被调用**（拒绝/取消已在工具循环侧过滤）。
   *
   * **缺省关**：新写入路径不擅自默认开启；是否默认开启**属决策事项**。
   */
  const diagnosticEventPort =
    options.isDiagnosticCollectionEnabled === true
      ? async (event: {
          sourceAgentInstanceId: string;
          missionIdentifier: string;
          taskIdentifier: string;
          errorCode: string;
          messageText: string;
          component: string;
          stage: "tool" | "provider";
          severity: "error";
        }): Promise<void> => {
          try {
            await new DiagnosticEventStore({ baseDirectory: options.stateDirectory }).append({
              observeEventVersion: 1,
              eventType: "diagnostic",
              recordedAtIso: new Date().toISOString(),
              sourceAgentInstanceId: event.sourceAgentInstanceId,
              missionIdentifier: event.missionIdentifier,
              taskIdentifier: event.taskIdentifier,
              requestIdentifier:
                event.missionIdentifier +
                ":" +
                event.taskIdentifier +
                ":" +
                event.component +
                ":" +
                event.errorCode,
              requestRevision: 1,
              origin: { kind: "system" },
              errorCode: event.errorCode,
              stage: event.stage,
              severity: event.severity,
              component: event.component,
              messageText: event.messageText,
              /**
               * 恢复状态：工具调用已失败并**如实返回给模型** ⇒ 该次调用已结束，
               * 但**是否已解决未知** ⇒ 用 `unknown`（不假装已恢复，也不假装仍在恢复）。
               */
              recoveryState: "unknown",
              /** 这是**本地观测到的真实失败**，不是推测 ⇒ 确定事实。 */
              classification: "deterministic-fact",
              /** 故障链：此处只有被观测到的这一层错误码，不伪造包装链。 */
              chain: { rootErrorCode: event.errorCode, wrapperErrorCodes: [] },
            });
          } catch {
            // 观测失败不得阻塞业务
          }
        }
      : undefined;

  /**
   * DIAG-01（2026-11-08，第 113 轮）：**使命级**诊断端口。
   *
   * 与上面的 `diagnosticEventPort` 同一开关（`isDiagnosticCollectionEnabled`，**缺省关**）
   * 与同一落库（`DiagnosticEventStore`），差别只在**归属**：使命级失败没有"某个任务"可归属
   * ⇒ `taskIdentifier` 为 `null`，`stage` 取 `git`／`recovery`／`dispatch`／`config`／`unknown`。
   *
   * **可达性如实标注**：`recovery`（租约续约失败）这条路径**生产可达**且有反例；
   * `git` 这条要等 T08 Git 集成整层接通后才会在生产发生
   * （见 `docs/reports/T08_GIT_INTEGRATION_PRODUCT_PATH_GAP_2026-11-08.md`）。
   */
  const missionDiagnosticEventPort =
    options.isDiagnosticCollectionEnabled === true
      ? async (event: MissionDiagnosticEvent): Promise<void> => {
          try {
            await new DiagnosticEventStore({ baseDirectory: options.stateDirectory }).append({
              observeEventVersion: 1,
              eventType: "diagnostic",
              recordedAtIso: new Date().toISOString(),
              sourceAgentInstanceId: event.sourceAgentInstanceId,
              missionIdentifier: event.missionIdentifier,
              /** 使命级失败不归属任何具体任务（不伪造归属）。 */
              taskIdentifier: null,
              requestIdentifier:
                event.missionIdentifier +
                "::" +
                event.component +
                ":" +
                event.errorCode,
              requestRevision: 1,
              origin: { kind: "system" },
              errorCode: event.errorCode,
              stage: event.stage,
              severity: "error",
              component: event.component,
              messageText: event.messageText,
              recoveryState: "unknown",
              classification: "deterministic-fact",
              chain: { rootErrorCode: event.errorCode, wrapperErrorCodes: [] },
            });
          } catch {
            // 观测失败不得阻塞业务
          }
        }
      : undefined;

  /** G2（第 130 轮）：活锁/循环守卫端口（缺省不构造 ⇒ 工具循环不启用守卫）。 */
  const progressGuardPort =
    options.isProgressGuardEnabled === true
      ? (() => {
          /**
           * 任务链总调用预算**持久化**（2026-11-08，第 162 轮）：按 ADR-0017 与
           * `T07E` L27「进程重启不能清零任务链累计预算」，把守卫的两个端口接到磁盘账本。
           */
          const taskCallBudgetLedger = new TaskCallBudgetLedger({ stateDirectory: options.stateDirectory });
          const progressGuard = new LocalProgressAndCycleGuard({
            taskTotalCallBudget: options.progressGuardTaskTotalCallBudget,
            readTaskBudget: (taskExecutionId) =>
              taskCallBudgetLedger.readTaskCallCount(taskExecutionId),
            writeTaskBudget: (taskExecutionId, callCount) =>
              taskCallBudgetLedger.writeTaskCallCount(taskExecutionId, callCount),
          });
          return async (input: {
            phase: "before-tool-execution" | "after-tool-execution";
            callerKey: string;
            calleeKey: string;
            taskExecutionId: string | null;
            outcomeSignature: string | null;
            isNewProgress: boolean;
          }) => {
            const violation = await progressGuard.recordCallAndDetectViolation({
              callerKey: input.callerKey,
              calleeKey: input.calleeKey,
              nodeKind: "tool",
              taskExecutionId: input.taskExecutionId,
              outcomeSignature: input.outcomeSignature,
              isNewProgress: input.isNewProgress,
            });
            return violation === null
              ? null
              : { kind: violation.kind, message: violation.message, cycleChain: violation.cycleChain };
          };
        })()
      : undefined;

  /**
   * EVENT-01：事件源桥（默认开启）。门禁接到既有 `workWindowGate` 接缝；
   * 崩溃类工具错误与连续 3 次 provider 失败才产生事故（低严重度不阻断）。
   */
  const eventControlBridge =
    options.isEventControlEnabled === false
      ? null
      : new EventSourceBridge({
          channel: new EventControlChannel({
            maximumConcurrentIncidents: 4,
            responseDeadlineSeconds: 60,
          }),
          journal: new EventIncidentJournal({ stateDirectory: options.stateDirectory }),
        });

  /**
   * ALIGN-01-01（2026-10-28）：稳定会话身份映射（**默认启用**，`false` 可关）。
   *
   * 只构造存储对象，不建目录：首次"带项目标识的用户消息"才落盘。
   */
  const conversationIdentityStore =
    options.isConversationIdentityEnabled === false
      ? null
      : new ConversationIdentityStore({ baseDirectory: stateDirectory });

  /**
   * ALIGN-02-02：模型背书的分解候选稿生产器（**默认不启用**）。
   *
   * 需要真实 worker 运行时；未配置时保持旧行为（单节点 + 摘要如实标注）。
   */
  const planningWorkerRuntimeFactory = options.workerRuntimeFactory;
  const taskDecompositionDraftProvider =
    options.isModelTaskPlanningEnabled === true &&
    planningWorkerRuntimeFactory !== undefined
      ? createModelBackedTaskDecompositionProvider({
          runtimeFactory: (plannerAgentInstanceIdentifier) =>
            planningWorkerRuntimeFactory(
              plannerAgentInstanceIdentifier,
              buildPlannerTaskPlaceholder(),
            ),
        })
      : undefined;

  /**
   * ALIGN-04-01（2026-10-28）：mission 关系索引（显式关联落盘 + 重启恢复映射）。
   *
   * 只由显式登记写入；重启时 `hydratePersistedMissionRelations()` 只恢复"记录里写过"的
   * 关联，不按昵称/路径猜测归属。
   */
  const missionRelationIndexStore = new MissionRelationIndexStore({
    baseDirectory: stateDirectory,
  });

  /**
   * ALIGN-04-02：恢复前只读对账门禁（可选，缺省关）。
   *
   * 只调用恢复中心的**只读** `inspectMission`：不续接、不改状态、不启动任务。
   */
  const missionRecoveryController =
    options.isMissionRecoveryGateEnabled === true
      ? new RecoveryCenterController({ baseDirectory: stateDirectory })
      : null;
  const missionRecoveryGate =
    missionRecoveryController === null
      ? undefined
      : async (missionId: string) => {
          try {
            const inspected = await missionRecoveryController.inspectMission(missionId);
            const blockedReasons: string[] = [];
            if (!inspected.view.exists) {
              blockedReasons.push("mission 不存在（摘要与任务链均缺失）");
            }
            if (inspected.view.isCorrupted) {
              blockedReasons.push("mission 状态损坏：需人工对账后再恢复");
            }
            if (inspected.view.reconciliationRequired) {
              blockedReasons.push(
                "检查点声明了 Git/worktree 状态：必须先完成只读对账再恢复",
              );
            }
            return {
              isAllowedToResume: blockedReasons.length === 0,
              blockedReasons,
            };
          } catch (error) {
            return {
              isAllowedToResume: false,
              blockedReasons: [`对账读取失败: ${(error as Error).message}`],
            };
          }
        };

  /**
   * 清单第 ① 项下半场：注入端口需要引用控制器本身。
   * 用 holder 对象而不是 `let`，避免闭包内被窄化成 never。
   */
  const controllerHolder: { current: MainController | null } = { current: null };
  const controller = new MainController({
      /**
       * HISTORY-01-02（第 42–43 轮）：运行历史存储（落 stateDirectory）。
       *
       * **默认保存**：卡内要求"关闭显示后仍保存" —— 保存与展示分离，不随视图开关；
       * 也不与其它特性耦合（此前误放进工具说明的三元里，已移出）。
       */
      runHistoryStore: new RunHistoryStore({ baseDirectory: options.stateDirectory }),
    /**
     * ALIGN-01-01（2026-10-28）：稳定会话 → 主个体 → 运行 的持久映射。
     *
     * 惰性落盘：只有"带项目标识的用户消息"才会创建
     * `<stateDirectory>/conversation-identity/conversations.json`。
     * 关闭开关 ⇒ 不构造、不落盘（旧行为）。
     */
    ...(conversationIdentityStore === null
      ? {}
      : { conversationIdentityStore, mainAgentInstanceId }),
    /** ALIGN-04-01：关系索引（显式关联落盘；重启恢复映射）。 */
    missionRelationIndexStore,
    /** ALIGN-04-02：恢复前只读对账门禁（缺省不传 ⇒ 不发生门禁）。 */
    ...(missionRecoveryGate === undefined ? {} : { missionRecoveryGate }),
    /** GOAL-02 R4：恢复前目标模式对账（未绑定目标时等价于不参与）。 */
    missionGoalResumeReconciliation,
    /** ALIGN-04-05：按调用者构造的回访控制器（胶囊 → 节点回访）。 */
    contextRecallControllerFactory,
    /**
     * ALIGN-02-01（2026-10-28）：权威任务序列控制面（用户任务先入偏序集，再建 mission 投影）。
     * 复用已装配的 `sequenceManageController`，不另建第二套序列。
     */
    taskSequenceManageController: sequenceManageController,
    /** 接线缺口第 ① 项（2026-10-28）：只读序列状态控制面（两套记账对照用）。 */
    taskSequenceStatusController: sequenceStatusController,
    taskLedgerDivergenceJournal,
    /** R21：mission↔序列 持久索引（控制器写入；CLI 读取）。 */
    missionSequenceBindingStore,
    /** R24：推迟插入队列（控制器入队；尚不消费）。 */
    deferredInsertionQueueStore,
    /** R34：目标组开始/结束（只在已绑定目标且 revision 一致时写状态）。 */
    goalTaskGroupStatePort,
    /** R51：组性质提供者（缺省不传 ⇒ normal；调查/返工不计入停滞）。 */
    ...(options.goalTaskGroupKindProvider === undefined
      ? {}
      : { goalTaskGroupKindProvider: options.goalTaskGroupKindProvider }),
    /**
     * 清单第 ① 项下半场（2026-10-28）：**运行中插入的真实注入端口**。
     *
     * 只在调度器无在途任务（安全点）时真的加入任务链并写回；
     * 否则返回 false，保持"推迟到下一组"的既有语义。
     */
    taskGroupInsertionPort: async (input): Promise<boolean> =>
      (await controllerHolder.current?.injectTaskIntoRunningMission(input)) ?? false,
    /** 清单第 ⑥ 项：目标门禁（缺省不参与；只观察/可选强制）。 */
    ...(options.goalDispatchGateResolver === undefined
      ? {
          /**
           * GOAL-02 R3（2026-10-29）：**本地解析器**。
           *
           * 按 mission 查缓存；未绑定/未还原 ⇒ null（目标模式不参与）。
           * `isGoalModeEnforcementEnabled` 仍默认 false ⇒ **只观察，不阻断派发**。
           */
          goalDispatchGateResolver: (missionIdentifier: string) =>
            isGoalModeActivated ? goalGateCache.resolve(missionIdentifier) : null,
        }
      : { goalDispatchGateResolver: options.goalDispatchGateResolver }),
    ...(options.isGoalModeEnforcementEnabled === true
      ? { isGoalModeEnforcementEnabled: true }
      : {}),
    /**
     * R35（2026-10-29）：判定**总是**落盘（有界 200 条），再转交宿主回调。
     *
     * 落盘失败不影响判定与派发（诊断不得成为单点故障）；记录不含正文。
     */
    onGoalDispatchVerdict: (verdictRecord: GoalDispatchVerdictRecord): void => {
      void goalDispatchVerdictJournal
        .record({
          missionIdentifier: verdictRecord.missionIdentifier,
          projectIdentifier: verdictRecord.projectIdentifier,
          contractRevision: verdictRecord.contractRevision,
          isAllowed: verdictRecord.isAllowed,
          reasonCode: verdictRecord.reasonCode,
          detail: verdictRecord.detail,
          evidenceGaps: [...verdictRecord.evidenceGaps],
          isEnforced: verdictRecord.isEnforced,
          observedAtIso: verdictRecord.observedAtIso,
        })
        .catch(() => undefined);
      options.onGoalDispatchVerdict?.(verdictRecord);
    },
    /** ALIGN-02-02：模型分解（缺省不传 ⇒ 单节点旧行为，摘要标 legacy-single-node）。 */
    ...(taskDecompositionDraftProvider === undefined
      ? {}
      : { taskDecompositionDraftProvider }),
    /**
     * ALIGN-01-05（2026-10-28）：主 Agent 单条处理预算（默认 180 秒）+ 超期落库。
     *
     * 落库位置 `<state>/main-agent-turns/<turnId>.json`：只记"本轮做了什么、
     * 超没超期、产出了多少字"，**不记**模型隐式状态；`isTaskDispatched` 恒 false。
     */
    mainAgentTurnBudgetMilliseconds:
      options.mainAgentTurnBudgetMilliseconds ?? MAIN_AGENT_TURN_BUDGET_MILLISECONDS,
    mainAgentTurnProgressPort: async (record) => {
      await writeAtomicJson(
        path.join(
          stateDirectory,
          "main-agent-turns",
          `${record.turnIdentifier}.json`,
        ),
        record,
      );
    },
    ...(eventControlBridge === null
      ? {}
      : {
          workWindowGate: async (input: {
            missionId: string;
            taskIdentifier: string;
            gatePoint: "dispatch" | "model" | "tool-execution";
            toolName?: string;
          }) => {
            const decision = await eventControlBridge.gate({
              gatePoint: input.gatePoint === "dispatch" ? "model" : input.gatePoint,
              ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
            });
            return decision.kind === "allow"
              ? { kind: "allow" as const, reason: decision.reason }
              : {
                  kind: "deny" as const,
                  reasonCode: decision.reasonCode,
                  reason: decision.reason,
                };
          },
          eventSourceHooks: {
            onToolFailed: (toolName: string, failureReason: string) => {
              void eventControlBridge.onToolFailed({ toolName, failureReason });
            },
            onProviderFailure: () => {
              void eventControlBridge.onProviderFailure({ resourceKey: "runtime" });
            },
          },
        }),
    /**
     * G4（第 281 轮）：构造**工具说明注入器**（回执存储落 stateDirectory）+ 透传登记表。
     * 未提供登记表 ⇒ 不构造、不注入（提示词逐字不变）。
     */
    ...(options.toolDocumentationRegistry === undefined
      ? {}
      : {
          toolDocumentationRegistry: options.toolDocumentationRegistry,
          toolDocumentationInjector: new ToolDocumentationRecallInjector(
            new ToolDocumentationReceiptStore({ baseDirectory: options.stateDirectory }),
          ),
        }),
    /** G1（第 255 轮）：构造 Git 集成四件套并交给控制器补全（worktree 端口带身份；永不自动合并）。 */
    ...(options.gitIntegration === undefined
      ? {}
      : {
          gitIntegration: {
            coordinator: new GitIntegrationCoordinator({
              worktreeAllocator: new GitWorktreeAllocator({ baseDirectory: options.stateDirectory }),
              verifier: new GitContributionVerifier(),
              reportStore: new GitIntegrationReportStore({ baseDirectory: options.stateDirectory }),
              recoveryPointService: new GitRecoveryPointService({ baseDirectory: options.stateDirectory }),
              /** 收尾第 5 步：透传"合并前要求审查者"（缺省 false，行为不变）。 */
              ...(options.gitIntegration.isReviewRequiredForMerge === true
                ? { isReviewRequiredForMerge: true }
                : {}),
            }),
            repositoryPath: options.gitIntegration.repositoryPath,
            targetBranchName: options.gitIntegration.targetBranchName,
            /** 收尾第 6 步：可配置；缺省保持空值（行为不变）。 */
            allowedPathsByTaskType:
              options.gitIntegration.allowedPathsByTaskType ?? {},
            integrationTestCommands:
              options.gitIntegration.integrationTestCommands ?? [],
          },
        }),
    modeMachine,
    missionRuntimeRegistry,
    artifactRecordStore,
    workWindowGateDecisionProvider: async (input) => {
      const workWindowRules = await projectWorkWindowStore.readRules(
        input.projectIdentifier ?? undefined,
      );
      const decision = evaluateWorkWindowGate({
        gatePoint: "dispatch",
        nowIso: input.nowIso,
        rules: workWindowRules,
        pauseReasonState: createPauseReasonState(),
      });
      return decision.kind === "allow"
        ? { isAllowed: true, reasonCode: "allowed", reason: decision.reason }
        : {
            isAllowed: false,
            reasonCode: decision.reasonCode,
            reason: decision.reason,
          };
    },
    missionRuntimePreparer: options.missionRuntimePreparer,
    sessionManager,
    taskStore,
    missionManager,
    registry,
    missionLeaseStore,
    processInstanceId,
    feedbackTransport: feedbackClient ?? createNoopFeedbackTransport(),
    workspaceBoundary,
    // GUI-02-03：把登记的项目根交给主控制器，使新建 mission 记录"所属项目"。
    registeredProjectRoots,
    temporaryDirectoryPath,
    concurrency: options.concurrency,
    failureThreshold: options.failureThreshold,
    maxLoopIterations: options.maxLoopIterations,
    /**
     * G5（2026-11-08 第 241 轮修复）：**开关必须进控制器选项**。
     * 此前第 235 轮的透传被插到了别的对象上（L1228 的 spread 不在 `new MainController({` 里）
     * ⇒ 控制器永远收到 `undefined` ⇒ 编排器 `enabled=false`（探针实测）。
     */
    ...(options.isCheckpointResumeEnabled === true ? { isCheckpointResumeEnabled: true } : {}),
    /** ALIGN-03-03：完成收据门禁（缺省关）。 */
    ...(options.isCompletionReceiptRequired === true
      ? { isCompletionReceiptRequired: true }
      : {}),
    /**
     * 计划 R7/R8（2026-10-29）：**完成收据的写与读**。
     *
     * 写入：调度器在 worker success 时保存 worker 给的收据；
     * 读取：严格模式下由控制器按 mission/task 读同一份存储（缺则视为"无收据"）。
     */
    completionReceiptStore,
    completionReceiptReader: async (missionIdentifier: string, taskIdentifier: string) =>
      await completionReceiptStore.read(missionIdentifier, taskIdentifier),
    /**
     * 计划 R10/R12（2026-10-29）：**独立裁决读取（逐任务对齐）**。
     *
     * 按控制器给出的**已 done 任务列表**逐个读取：
     * - 任务缺裁决 ⇒ 不通过，理由列出缺失任务；
     * - 任意任务 rejected ⇒ 不通过，带出 `task: reason`；
     * - 全部 accepted ⇒ 通过；空列表 ⇒ null。
     * 读取不伪造：存储损坏/缺失一律按"缺裁决"处理。
     */
    completionVerdictReader: async (
      missionIdentifier: string,
      taskIdentifiers: readonly string[],
    ) => {
      if (taskIdentifiers.length === 0) {
        return null;
      }
      const missingTaskIdentifiers: string[] = [];
      const rejectedReasons: string[] = [];
      for (const taskIdentifier of taskIdentifiers) {
        const verdictRecord = await completionVerdictStore.read(
          missionIdentifier,
          taskIdentifier,
        );
        if (verdictRecord === null) {
          missingTaskIdentifiers.push(taskIdentifier);
          continue;
        }
        if (verdictRecord.verdict === "rejected") {
          rejectedReasons.push(
            `${taskIdentifier}: ${verdictRecord.reasons.join("；")}`,
          );
        }
      }
      const reasons = [
        ...(missingTaskIdentifiers.length === 0
          ? []
          : [`缺少任务裁决: ${missingTaskIdentifiers.join(", ")}`]),
        ...rejectedReasons,
      ];
      return { isAccepted: reasons.length === 0, reasons };
    },
    backupVault,
    backupDeletionController,
    workArchiveStore,
    permissionProfileStore,
    permissionCapabilityCatalog: permissionCatalog,
    currentPermissionSelectionStore,
    currentPermissionProfileReference,
    // 修复（2026-10-01）：裁决授权必须能写进判定侧引擎，否则批准后重跑仍要求逐次裁决。
    configurablePermissionPolicyEngine,
    // 修复（2026-10-01）：被询问拦下的那次会消耗作用域一次性授权，授权时需重新登记。
    scopeAuthorizationGate,
    // 用**解析后**的身份（host 上下文回退），不是原始 options 值。
    authenticatedUserId,
    mainAgentReadonlyProjection,
    sessionElevationStore,
    sessionElevationController,
    sessionElevationResolver,
    sessionExporter,
    sessionShutdownCoordinator,
    registeredAgentDirectory,
    reportArchiveIngestor,
    conversationTaskInsertionController,
    secondaryDispatchLoop,
    tertiaryLifecycleController,
    tertiaryRuntimeComponents,
    t08cRoutingFacade,
    mainRuntimeFactory:
      options.mainRuntimeFactory ??
      (() =>
        new ScriptedRuntime([
          {
            type: "text",
            text: "（主 Agent 应答）任务已受理。",
          },
          { type: "finish", reason: "success", detail: "受理完成" },
        ])),
    workerRuntimeFactory:
      options.workerRuntimeFactory ??
      (() =>
        new ScriptedRuntime([
          { type: "text", text: "（mock 执行器）" },
          { type: "finish", reason: "success", detail: "任务完成" },
        ])),
    /**
     * 工具端口工厂：**必须接收具体 Agent 实例身份**（2026-10-02 真实实测缺陷修复）。
     *
     * 此前只有 `task`，导致 `agentInstanceId` 与 `taskExecutionId` 都用 `task.id` 合成
     * （`worker:T-001` / `task-exec:T-001`）。两个并行 mission 各有一条 `T-001` 时，
     * 二者在**读取抑制账本**（键含 agentInstanceId + taskExecutionId）上生成**完全相同的键**，
     * 于是第二个 Agent 的合法读取被误判为"同一调用源重复读取"→ `resource-already-read`
     * （真实 u2-flash 实测稳定复现：并发第二条任务必然失败）。
     */
    buildWorkerToolPort: (
      task: TaskDependencyNode,
      allowedToolNames: Set<string>,
      agentInstanceId?: string,
      workspaceRootPath?: string,
      projectIdentifier?: string,
      missionIdentifier?: string,
    ) =>
      new ScopeGatedToolPort(
        createPolicyWrapperForAgent({
          agentInstanceId: agentInstanceId ?? `worker:${task.id}`,
          allowedToolNames,
          factVerificationClaimIdentifier: `task-exec:${agentInstanceId ?? task.id}`,
          taskExecutionId: `task-exec:${agentInstanceId ?? task.id}`,
          useConfigurablePermissionProfileEngine: true,
          missionIdentifier: missionIdentifier ?? "unknown-mission",
          taskIdentifier: task.id,
          ...(workspaceRootPath === undefined ? {} : { workspaceRootPath }),
          ...(projectIdentifier === undefined ? {} : { projectIdentifier }),
        }),
        scopeAuthorizationGate,
      ),
    buildRecoveryCheckpointingToolPort,
    // T06B/ADR-0014：思索模式本地只读白名单（查看项目文件、检索文本和查询只读任务状态）。
    // 只暴露白名单工具描述符；权限裁决与策略引擎在派发与真实执行两个时点 fail-closed。
    ponderReadonlyToolingFactory: (agentInstanceId: string) => {
      /**
       * ALIGN-01-03：过滤条件是"已注册 **且** 在只读投影内"。
       * 第二项此前缺失 —— 工具面只看 ponder 自己的常量，投影再严格也管不到它。
       */
      const allowedToolNames = new Set(
        PONDER_READONLY_TOOL_NAMES.filter(
          (toolName) =>
            registry.getDescriptor(toolName) !== undefined &&
            mainAgentReadonlyProjection.isMainAgentToolAllowed(toolName),
        ),
      );
      const toolDescriptors = [...allowedToolNames]
        .map((toolName) => registry.getDescriptor(toolName))
        .filter(
          (descriptor): descriptor is ToolDescriptor => descriptor !== undefined,
        );
      return {
        toolDescriptors,
        toolPort: createPolicyWrapperForAgent({
          agentInstanceId,
          allowedToolNames,
          factVerificationClaimIdentifier: null,
          taskExecutionId: null,
          useConfigurablePermissionProfileEngine: false,
        }),
      };
    },
    buildPermissionExplanation: (toolName: string) =>
      `执行任务需要调用工具 ${toolName}`,
    // PERF-01-02（第 83 轮）：性能样本落库端口（开关关时 undefined ⇒ 不采集）
    ...(perfSamplePort === undefined ? {} : { perfSamplePort }),
    // DIAG-01（第 85 轮）：诊断事件落库端口（开关关时 undefined ⇒ 不采集）
    ...(diagnosticEventPort === undefined ? {} : { diagnosticEventPort }),
    // DIAG-01（第 113 轮）：**使命级**诊断端口（同一开关；缺省 undefined ⇒ 不采集）
    ...(missionDiagnosticEventPort === undefined ? {} : { missionDiagnosticEventPort }),
    // G2（第 130 轮）：守卫端口（缺省 undefined ⇒ 不启用）
    ...(progressGuardPort === undefined ? {} : { progressGuardPort }),
    // G3（第 133 轮）：高严谨性强制事实验证开关（缺省关 ⇒ 不传）
    ...(options.isCheckpointResumeEnabled === true
      ? { isCheckpointResumeEnabled: true }
      : {}),
    ...(options.isHighRigorEnforcementEnabled === true
      ? { isHighRigorEnforcementEnabled: true }
      : {}),
    resolveToolDescriptors: (task: TaskDependencyNode): ToolDescriptor[] =>
      task.toolNames
        .map((toolName) => registry.getDescriptor(toolName))
        .filter((descriptor): descriptor is ToolDescriptor => descriptor !== undefined),
    requireCompletionControlEvent: options.requireCompletionControlEvent ?? false,
    isConversationMode: options.isConversationMode === true,
    // 产物对账必须使用与工具写入一致的工作区根（2026-10-02）。
    artifactWorkspaceRootPath: registeredProjectRoots[0]?.rootPath ?? process.cwd(),
    contextPromptProvider,
    guidanceControlQueue,
    contextNodeLifecycle,
    streamOutput: options.streamOutput,
    // GUI-02-01 片①：把权限询问的绝对身份透传给宿主（可选；未提供则不传该字段）。
    ...(options.onPermissionAskWithIdentity === undefined
      ? {}
      : { onPermissionAskWithIdentity: options.onPermissionAskWithIdentity }),
    ...(options.onPermissionAsk === undefined
      ? {}
      : { onPermissionAsk: options.onPermissionAsk }),
  });

  const shutdown = async (): Promise<void> => {
    /** 接线缺口第 ④ 项：先停时段检测器（幂等；未启动时返回 not-running）。 */
    workWindowTransitionMonitor.stop();
    // T07D-R1-03：先收敛在途编排（取消并等待 Worker/循环），再释放反馈进程资源。
    await controller.shutdown().catch(() => {});
    // 反馈进程**由 supervisor 独占收口**：`stop()` 内部即 `client.shutdown()` +
    // 等待子进程退出 + 置空引用。此处**不得**再单独调用 `feedbackClient.shutdown()`：
    // 子进程在收到第一个 shutdown 请求后发送 `shutdownComplete` 并 `process.exit(0)`，
    // 第二个请求永远不会有应答 ⇒ 客户端只能等到 `requestTimeoutMilliseconds`
    // （默认 5_000ms）再吞掉超时。实测：单次 stop 约 8ms，重复序列 **502ms→5014ms**。
    await supervisor?.stop().catch(() => {});
  };

  const readMissionResultSummaries = async (
    missionId: string,
  ): Promise<Array<{ taskId: string | null; entryType: string; summary: string }>> => {
    const inMemory = inMemoryResultSummariesByMission.get(missionId);
    if (inMemory !== undefined && inMemory.length > 0) {
      return [...inMemory];
    }
    const agentInstanceIds = await workArchiveStore.listAgentIdsWithArchive(missionId);
    const summaries: Array<{ taskId: string | null; entryType: string; summary: string }> = [];
    for (const agentInstanceId of agentInstanceIds) {
      const archive = await workArchiveStore
        .readArchive(missionId, agentInstanceId)
        .catch(() => null);
      if (archive === null) {
        continue;
      }
      for (const entry of archive.entries) {
        if (entry.entryType === "result") {
          summaries.push({
            taskId: entry.taskId,
            entryType: entry.entryType,
            summary: entry.summary,
          });
        }
      }
    }
    return summaries;
  };

  /**
   * ALIGN-04-01（2026-10-28）：启动时从**权威关系索引**恢复 mission 映射。
   *
   * 只恢复"记录里明确写过"的关联；失败不阻断启动（索引是辅助恢复），但如实写到 stderr
   * —— 不静默假装恢复成功。
   */
  try {
    await controller.hydratePersistedMissionRelations();
  } catch (error) {
    process.stderr.write(
      `astarray: 关系索引恢复失败（本次不恢复 mission 映射）: ${(error as Error).message}\n`,
    );
  }

  return {
    controller,
    missionManager,
    taskStore,
    supervisor,
    feedbackClient,
    runtimeKind: options.runtimeKind ?? "mock",
    isFeedbackProcessIndependent: feedbackClient !== null,
    requiresCompletionControlEvent: options.requireCompletionControlEvent ?? false,
    missionLeaseStore,
    processInstanceId,
    registeredAgentDirectory,
    reconnaissanceController,
    taskSequenceManageController: sequenceManageController,
    standaloneWorkflowRunner,
    readMissionResultSummaries,
    globalContextBudgetStore,
    scopedSettingsStore,
    agentModelBindingStore,
    missionRuntimeRegistry,
    artifactRecordStore,
    projectWorkWindowStore,
    workWindowTransitionMonitor,
    taskLedgerDivergenceJournal,
    goalModeStateStore,
    goalContractStore,
    goalMissionBindingStore,
    goalGateCache,
    goalGateHydration,
    completionReceiptStore,
    completionVerdictStore,
    activateGoalMode,
    getGoalModeActivation,
    createGoalContract,
    bindMissionToGoal,
    unbindMissionFromGoal,
    closeGoalExperiment,
    describeGoalStatus,
    deactivateGoal,
    updateGoalContract,
    refreshGoalGateCache,
    experimentSettingsStore,
    toolPackageLifecycleService,
    toolPackageZipInstaller,
    contextRuntimeEventStore,
    guidanceControlQueue,
    longToolCheckpointController,
    guidanceSubmissionJournal,
    guidanceChangeIntentController,
    guidanceChangeIntentJournal,
    authenticatedUserId,
    authenticatedUserSource,
    hasBackupDeletionControlPort: backupDeletionControlPort !== null,
    hasInstallationUserPort: installationUserPort !== null,
    registeredProjectRoots,
    scopeAuthorizationGate,
    accuracyPolicyStore,
    accuracyAttemptJournal,
    accuracyVerificationAuditLog,
    localPreservationService,
    humanVerificationController,
    contextClosureCapsuleStore,
    contextGraphStore,
    mainAgentInstanceId,
    sessionElevationStore,
    sessionElevationController,
    shutdown,
  };
}

import type { FeedbackTransportPort } from "../core/types.js";

function createNoopFeedbackTransport(): FeedbackTransportPort {
  return {
    enqueue: async () => {},
    queryHealth: async () => ({
      isHealthy: true,
      processPid: null,
      protocolVersion: 1,
      queuedMessageCount: 0,
    }),
    shutdown: async () => {},
    setAgentStatus: () => {},
    onMessage: () => {},
  };
}























