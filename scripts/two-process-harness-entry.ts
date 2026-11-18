/**
 * WIRING-04 §36.4 双进程反例的**测试入口**（2026-11-18）。
 *
 * 由 `scripts/verify-two-process-stale-write.mjs` 用 tsup 打成单文件 ESM，
 * 再由两个**独立 node 进程**通过 IPC 消息驱动，避免"睡眠赌顺序"。
 */
import { TaskStore } from "../packages/core/src/infra/task-store.js";

export { TaskStore };

export function openStore(stateDirectory: string): TaskStore {
  return new TaskStore({ baseDirectory: stateDirectory });
}

export async function readChainRevision(
  stateDirectory: string,
): Promise<{ revision: number; status: string }> {
  const chain = await openStore(stateDirectory).readTaskChain("mission-1");
  return {
    revision: chain?.revision ?? 0,
    status: chain?.tasks[0]?.status ?? "missing",
  };
}

/**
 * 以**调用方持有的 revision** 提交新状态。
 * 旧 revision ⇒ 期望被 `stale-revision` 拒绝（权威记录的 CAS 语义）。
 */
export async function submitStaleOrFresh(input: {
  stateDirectory: string;
  expectedRevision: number;
  status: "running" | "done";
}): Promise<{ outcome: "accepted" | "rejected"; errorCode: string | null; revision: number }> {
  const store = openStore(input.stateDirectory);
  const chain = await store.readTaskChain("mission-1");
  if (chain === null) {
    return { outcome: "rejected", errorCode: "task-not-found", revision: 0 };
  }
  try {
    await store.writeTaskChain({
      ...chain,
      revision: input.expectedRevision + 1,
      tasks: chain.tasks.map((task) => ({ ...task, status: input.status })),
    } as never);
    return {
      outcome: "accepted",
      errorCode: null,
      revision: input.expectedRevision + 1,
    };
  } catch (error) {
    return {
      outcome: "rejected",
      errorCode: (error as { errorCode?: string }).errorCode ?? "unknown",
      revision: chain.revision,
    };
  }
}

/**
 * §36.2 逐存储反例：目标模式状态（`goal-mode/<goal>.json`）。
 */
import { GoalModeStateStore } from "../packages/core/src/orchestration/goal-mode-store.js";

export function openGoalModeStore(stateDirectory: string): GoalModeStateStore {
  return new GoalModeStateStore({ baseDirectory: stateDirectory });
}

export async function seedGoalState(input: {
  stateDirectory: string;
  goalIdentifier: string;
  documentRevision: number;
  pauseReason: string;
}): Promise<{ written: boolean }> {
  const store = openGoalModeStore(input.stateDirectory);
  const result = await store.writeIfDocumentRevision({
    state: {
      schemaVersion: 1,
      documentRevision: input.documentRevision,
      goalIdentifier: input.goalIdentifier,
      contractRevision: 1,
      ownerIdentifier: "user-1",
      sourceRequestReference: "request-1",
      requirementBases: [],
      lastPotentialValue: null,
      currentTaskGroupIdentifier: null,
      currentTaskGroupStartedAtIso: null,
      consumedToolCalls: 0,
      evidenceGaps: [],
      requiresReplanning: false,
      pauseReason: input.pauseReason,
      isExperimentClosed: false,
      closedAtIso: null,
      updatedAtIso: "2026-11-18T00:00:00.000Z",
    } as never,
    expectedDocumentRevision: 0,
  });
  return { written: result.outcome === "written" };
}

export async function readGoalStateRevision(input: {
  stateDirectory: string;
  goalIdentifier: string;
}): Promise<{ documentRevision: number; pauseReason: string | null }> {
  const state = await openGoalModeStore(input.stateDirectory).read(input.goalIdentifier);
  return {
    documentRevision: state?.documentRevision ?? 0,
    pauseReason: state?.pauseReason ?? null,
  };
}

export async function submitGoalStateCas(input: {
  stateDirectory: string;
  goalIdentifier: string;
  expectedDocumentRevision: number;
  pauseReason: string;
}): Promise<{ outcome: "written" | "conflict"; currentDocumentRevision: number }> {
  const store = openGoalModeStore(input.stateDirectory);
  const current = await store.read(input.goalIdentifier);
  const base = current ?? null;
  if (base === null) {
    return { outcome: "conflict", currentDocumentRevision: 0 };
  }
  return store.writeIfDocumentRevision({
    state: {
      ...base,
      documentRevision: input.expectedDocumentRevision + 1,
      pauseReason: input.pauseReason,
      updatedAtIso: "2026-11-18T00:00:01.000Z",
    },
    expectedDocumentRevision: input.expectedDocumentRevision,
  });
}

/**
 * §36.3 逐存储反例：完成收据（`completion-receipts/<mission>/<task>.json`）。
 */
import { CompletionReceiptStore } from "../packages/core/src/orchestration/completion-receipt-store.js";

export function openReceiptStore(stateDirectory: string): CompletionReceiptStore {
  return new CompletionReceiptStore({ baseDirectory: stateDirectory });
}

export async function readReceiptSummary(input: {
  stateDirectory: string;
  missionIdentifier: string;
  taskIdentifier: string;
}): Promise<{ toolCallCount: number | null; artifactPath: string | null }> {
  const receipt = await openReceiptStore(input.stateDirectory).read(
    input.missionIdentifier,
    input.taskIdentifier,
  );
  return {
    toolCallCount: (receipt as unknown as { toolCallCount?: number } | null)?.toolCallCount ?? null,
    artifactPath:
      (receipt as unknown as { artifactPaths?: string[] } | null)?.artifactPaths?.[0] ?? null,
  };
}

export async function saveReceiptIfAbsent(input: {
  stateDirectory: string;
  missionIdentifier: string;
  taskIdentifier: string;
  toolCallCount: number;
  artifactPath: string;
}): Promise<{ outcome: "written" | "idempotent" | "rejected"; errorCode: string | null }> {
  try {
    const result = await openReceiptStore(input.stateDirectory).save({
      missionIdentifier: input.missionIdentifier,
      taskIdentifier: input.taskIdentifier,
      toolCallCount: input.toolCallCount,
      artifactPaths: [input.artifactPath],
      hasVerifiedCompletionControlEvent: true,
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    } as never);
    return { outcome: result.didWrite ? "written" : "idempotent", errorCode: null };
  } catch (error) {
    return {
      outcome: "rejected",
      errorCode: (error as { errorCode?: string }).errorCode ?? "unknown",
    };
  }
}

/**
 * §36.3 逐存储反例：独立完成裁决（`completion-verdicts/<mission>/<task>.json`）。
 */
import { CompletionVerdictStore } from "../packages/core/src/orchestration/completion-verdict-store.js";

export function openVerdictStore(stateDirectory: string): CompletionVerdictStore {
  return new CompletionVerdictStore({ baseDirectory: stateDirectory });
}

export async function readVerdictSummary(input: {
  stateDirectory: string;
  missionIdentifier: string;
  taskIdentifier: string;
}): Promise<{ verdict: string | null; decider: string | null }> {
  const record = await openVerdictStore(input.stateDirectory).read(
    input.missionIdentifier,
    input.taskIdentifier,
  );
  return { verdict: record?.verdict ?? null, decider: record?.deciderAgentInstanceIdentifier ?? null };
}

export async function saveVerdictIfAbsent(input: {
  stateDirectory: string;
  missionIdentifier: string;
  taskIdentifier: string;
  verdict: "accepted" | "rejected";
  deciderAgentInstanceIdentifier: string;
}): Promise<{ outcome: "written" | "idempotent" | "rejected"; errorCode: string | null }> {
  try {
    const result = await openVerdictStore(input.stateDirectory).save({
      missionIdentifier: input.missionIdentifier,
      taskIdentifier: input.taskIdentifier,
      verdict: input.verdict,
      reasons: input.verdict === "accepted" ? [] : ["证据不足"],
      deciderAgentInstanceIdentifier: input.deciderAgentInstanceIdentifier,
      decidedAtIso: "2026-11-18T00:00:00.000Z",
    });
    return { outcome: result.didWrite ? "written" : "idempotent", errorCode: null };
  } catch (error) {
    return {
      outcome: "rejected",
      errorCode: (error as { errorCode?: string }).errorCode ?? "unknown",
    };
  }
}

/**
 * §36.2 逐存储反例：启动恢复尝试计数（`startup-recovery/attempts.json`）。
 */
import { StartupRecoveryAttemptStore } from "../packages/core/src/orchestration/startup-recovery-runner.js";

export async function recordStartupFailure(input: {
  stateDirectory: string;
  missionIdentifier: string;
}): Promise<{ attemptCount: number }> {
  const record = await new StartupRecoveryAttemptStore({
    baseDirectory: input.stateDirectory,
  }).recordAttempt({
    missionIdentifier: input.missionIdentifier,
    outcome: "failed",
    reason: "恢复失败",
    attemptedAtIso: "2026-11-18T00:00:00.000Z",
  });
  return { attemptCount: record.attemptCount };
}

export async function readStartupFailureCount(input: {
  stateDirectory: string;
  missionIdentifier: string;
}): Promise<{ attemptCount: number }> {
  const record = await new StartupRecoveryAttemptStore({
    baseDirectory: input.stateDirectory,
  }).readAttempt(input.missionIdentifier);
  return { attemptCount: record?.attemptCount ?? 0 };
}

/**
 * §36.2 逐存储反例：启动恢复策略（`startup-recovery/policy.json`）。
 */
import {
  DEFAULT_STARTUP_RECOVERY_POLICY,
  StartupRecoveryPolicyStore,
} from "../packages/core/src/orchestration/startup-recovery-policy.js";

export async function readStartupPolicyRevision(input: {
  stateDirectory: string;
}): Promise<{ documentRevision: number; maximumResumePerStartup: number | null }> {
  const store = new StartupRecoveryPolicyStore({ baseDirectory: input.stateDirectory });
  const revision = await store.readPolicyRevision();
  const { policy, isPersisted } = await store.readPolicy();
  return {
    documentRevision: revision,
    maximumResumePerStartup: isPersisted ? policy.maximumResumePerStartup : null,
  };
}

export async function submitStartupPolicyCas(input: {
  stateDirectory: string;
  expectedRevision: number;
  maximumResumePerStartup: number;
}): Promise<{ outcome: "written" | "conflict"; currentRevision: number }> {
  const store = new StartupRecoveryPolicyStore({ baseDirectory: input.stateDirectory });
  return store.writePolicyIfRevision({
    policy: { ...DEFAULT_STARTUP_RECOVERY_POLICY, maximumResumePerStartup: input.maximumResumePerStartup },
    expectedRevision: input.expectedRevision,
  });
}

/**
 * §36.2 逐存储反例（第二批）：目标契约、会话运行、提案确认、工具包反馈。
 */
import { GoalContractStore } from "../packages/core/src/orchestration/goal-contract-store.js";
import { GOAL_CONTRACT_SCHEMA_VERSION } from "../packages/core/src/orchestration/goal-contract.js";
import { ConversationIdentityStore } from "../packages/core/src/orchestration/conversation-identity-store.js";
import { GoalContractProposalStore } from "../packages/core/src/orchestration/goal-contract-proposal.js";
import { ToolPackageOperationFeedbackStore } from "../packages/core/src/toolkit/tool-package-operation-control.js";

function buildContractFixture(revision: number, objectiveText: string) {
  return {
    schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
    goalIdentifier: "goal-1",
    revision,
    ownerIdentifier: "user-1",
    sourceRequestReference: "request-1",
    objectiveText,
    scope: { projectIdentifiers: [], allowedToolNames: null },
    nonViolableInvariants: [],
    requirements: [
      {
        requirementIdentifier: "req-1",
        description: "写完说明",
        weight: 1,
        completionPredicateKind: "deterministic-check",
      },
    ],
    resourceLimits: {
      maximumToolCalls: null,
      maximumWallClockSeconds: null,
      maximumCostUnits: null,
    },
    deadlineIso: null,
    pauseConditions: [],
    supersedesRevision: null,
  } as never;
}

export async function readGoalContractSummary(input: {
  stateDirectory: string;
}): Promise<{ revision: number; objectiveText: string | null }> {
  const contract = await new GoalContractStore({
    baseDirectory: input.stateDirectory,
  }).read("goal-1");
  return {
    revision: contract?.revision ?? 0,
    objectiveText: contract?.objectiveText ?? null,
  };
}

export async function submitGoalContractCas(input: {
  stateDirectory: string;
  expectedRevision: number;
  revision: number;
  objectiveText: string;
}): Promise<{ outcome: "written" | "conflict"; currentRevision: number }> {
  return new GoalContractStore({ baseDirectory: input.stateDirectory }).saveIfRevision({
    contract: buildContractFixture(input.revision, input.objectiveText),
    expectedRevision: input.expectedRevision,
  });
}

export async function openConversationIfNeeded(input: {
  stateDirectory: string;
  conversationIdentifier: string;
}): Promise<{ opened: boolean }> {
  const store = new ConversationIdentityStore({ baseDirectory: input.stateDirectory });
  const existing = await store.getConversation(input.conversationIdentifier);
  if (existing !== null) {
    return { opened: false };
  }
  await store.openConversation({
    projectIdentifier: "project-alpha",
    conversationIdentifier: input.conversationIdentifier,
    mainAgentInstanceIdentifier: "main-agent-1",
  });
  return { opened: true };
}

export async function beginConversationRun(input: {
  stateDirectory: string;
  conversationIdentifier: string;
  missionIdentifier: string;
}): Promise<{ runCount: number }> {
  const store = new ConversationIdentityStore({ baseDirectory: input.stateDirectory });
  await store.beginRun({
    conversationIdentifier: input.conversationIdentifier,
    missionIdentifier: input.missionIdentifier,
    userMessageReference: `message-${input.missionIdentifier}`,
  });
  const conversation = await store.getConversation(input.conversationIdentifier);
  return { runCount: conversation?.runs.length ?? 0 };
}

export async function saveProposalAndConfirm(input: {
  stateDirectory: string;
  proposalIdentifier: string;
  confirmedGoalIdentifier: string;
  createIfMissing: boolean;
}): Promise<{ outcome: "written" | "conflict" | "idempotent"; errorCode: string | null }> {
  const store = new GoalContractProposalStore({ baseDirectory: input.stateDirectory });
  if (input.createIfMissing) {
    await store.save({
      schemaVersion: 1,
      proposalIdentifier: input.proposalIdentifier,
      sourceRequestReference: "request-1",
      draft: {
        objectiveText: "把文档补完",
        requirements: [],
        scope: { projectIdentifiers: [], allowedToolNames: null },
        nonViolableInvariants: [],
        resourceLimits: {
          maximumToolCalls: null,
          maximumWallClockSeconds: null,
          maximumCostUnits: null,
        },
        deadlineIso: null,
        pauseConditions: [],
      },
      createdAtIso: "2026-11-18T00:00:00.000Z",
      expiresAtIso: "2026-12-31T00:00:00.000Z",
      confirmedAtIso: null,
      confirmedGoalIdentifier: null,
    } as never);
  }
  try {
    const existing = await store.read(input.proposalIdentifier);
    if (existing?.confirmedAtIso !== null && existing?.confirmedAtIso !== undefined) {
      return { outcome: "idempotent", errorCode: null };
    }
    await store.markConfirmed({
      proposalIdentifier: input.proposalIdentifier,
      confirmedGoalIdentifier: input.confirmedGoalIdentifier,
      confirmedAtIso: "2026-11-18T00:00:01.000Z",
    });
    return { outcome: "written", errorCode: null };
  } catch (error) {
    return {
      outcome: "conflict",
      errorCode: (error as { errorCode?: string }).errorCode ?? "unknown",
    };
  }
}

export async function appendToolkitFeedback(input: {
  stateDirectory: string;
  detail: string;
}): Promise<{ recordCount: number }> {
  const store = new ToolPackageOperationFeedbackStore({ stateDirectory: input.stateDirectory });
  await store.appendRecord({
    toolPackageId: "package-1",
    projectIdentifier: "project-alpha",
    requestingAgentInstanceId: "agent-1",
    actionKind: "enable",
    revision: 1,
    outcome: "succeeded",
    detail: input.detail,
  } as never);
  const records = await store.listRecords();
  return { recordCount: records.length };
}
