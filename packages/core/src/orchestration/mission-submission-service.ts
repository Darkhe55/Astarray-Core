/**
 * MISSION-WRITE-01 切片 3/4（2026-11-28）：**任务提交编排服务**。
 *
 * 把 `AstarrayApplicationFacade.submitTask` 的控制流搬到这里：
 * 幂等判定 → 既有任务判定 → ponder/目标 Agent/执行根校验 → 指令窗口准入 →
 * 排队分支 → 提交控制器 → 记录受理 → 结算幂等 claim → 发事件 → 启动监视器。
 *
 * 边界：
 * - 状态（任务表、幂等账本、指令窗口、监视器）仍由门面持有，经**端口**注入；
 * - 错误构造由端口注入（保持 `PublicApplicationError` 的错误码/文案逐字不变，且避免循环依赖）；
 * - 纯判定复用 `mission-task-registry.ts`（切片 1/2 已抽出）。
 */
import {
  computeTaskSubmissionInputHash,
  evaluateExistingTaskForSubmission,
  evaluateIdempotentSubmission,
  type MissionTaskIdempotencyEntry,
} from "./mission-task-registry.js";

export type MissionSubmissionTaskStatus =
  | "accepted"
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface MissionTaskRecordData {
  sessionId: string;
  missionIdentifier: string | null;
  status: MissionSubmissionTaskStatus;
  summaryPreview: string | null;
  revision: number;
  instructionLink: { instructionIdentifier: string; instructionRevision: number } | null;
  queuedPrompt: string | null;
}

export interface MissionSubmissionResultData {
  taskIdentifier: string;
  status: MissionSubmissionTaskStatus;
  missionIdentifier: string | null;
  summaryPreview: string | null;
}

export interface MissionSubmissionInputData {
  sessionId: string;
  taskIdentifier: string;
  prompt: string;
  idempotencyKey?: string;
  projectIdentifier?: string;
  workspaceRootPath?: string;
  targetAgentInstanceIdentifier?: string;
  goalIdentifier?: string;
}

export type MissionInstructionAdmission =
  | { readonly kind: "queued"; readonly link: { instructionIdentifier: string; instructionRevision: number } }
  | { readonly kind: "windowed"; readonly link: { instructionIdentifier: string; instructionRevision: number } }
  | { readonly kind: "unwindowed" };

/** 提交编排所需的全部外部能力（由门面提供）。 */
export interface MissionSubmissionServicePorts {
  assertOpen(): void;
  requireSession(sessionId: string): void;
  findIdempotencyEntry(ledgerKey: string): MissionTaskIdempotencyEntry | undefined;
  findTaskRecord(taskIdentifier: string): MissionTaskRecordData | undefined;
  currentMode(): "ponder" | "assist" | "devolve";
  validateTargetAgentInstance(agentInstanceIdentifier: string): Promise<void>;
  validateWorkspaceRootPath(workspaceRootPath: string): Promise<void>;
  admitInstruction(input: MissionSubmissionInputData): Promise<MissionInstructionAdmission>;
  submitPromptToController(input: {
    prompt: string;
    sessionId: string;
    projectIdentifier?: string;
    workspaceRootPath?: string;
    targetAgentInstanceIdentifier?: string;
    goalIdentifier?: string;
  }): Promise<string>;
  registerTaskRecord(taskIdentifier: string, record: MissionTaskRecordData): void;
  markTaskQueued(taskIdentifier: string): void;
  claimIdempotency(
    ledgerKey: string,
    entry: MissionTaskIdempotencyEntry,
  ): Promise<void>;
  settleIdempotencyClaim(ledgerKey: string, missionIdentifier: string): Promise<void>;
  emitTaskStatus(input: {
    taskIdentifier: string;
    status: MissionSubmissionTaskStatus;
    revision: number;
  }): void;
  startTaskMonitor(taskIdentifier: string): void;
  toTaskResult(taskIdentifier: string, record: MissionTaskRecordData): MissionSubmissionResultData;
  createPublicError(errorCode: string, message: string): Error;
  nowIso(): string;
  /** 取消路径端口（切片 4b）：任务查找、终态判定、监视器、队列、控制器取消、槽位释放。 */
  requireTask(taskIdentifier: string, sessionId: string): MissionTaskRecordData;
  isTerminalStatus(status: MissionSubmissionTaskStatus): boolean;
  stopTaskMonitor(taskIdentifier: string): void;
  removeQueuedTask(taskIdentifier: string): boolean;
  cancelMission(missionIdentifier: string): Promise<void>;
  emitTaskFinished(input: {
    taskIdentifier: string;
    status: MissionSubmissionTaskStatus;
    revision: number;
  }): void;
  releaseInstructionSlot(
    record: MissionTaskRecordData,
    terminalStatus: MissionSubmissionTaskStatus,
  ): Promise<void>;
}

export class MissionSubmissionService {
  constructor(private readonly ports: MissionSubmissionServicePorts) {}

  async submitTask(input: MissionSubmissionInputData): Promise<MissionSubmissionResultData> {
    const ports = this.ports;
    ports.assertOpen();
    ports.requireSession(input.sessionId);

    /** 幂等 claim（在任何 await 之前判定；与门面原实现同一顺序）。 */
    const submissionInputHash = computeTaskSubmissionInputHash({
      prompt: input.prompt,
      ...(input.projectIdentifier === undefined
        ? {}
        : { projectIdentifier: input.projectIdentifier }),
      ...(input.workspaceRootPath === undefined
        ? {}
        : { workspaceRootPath: input.workspaceRootPath }),
      ...(input.targetAgentInstanceIdentifier === undefined
        ? {}
        : { targetAgentInstanceIdentifier: input.targetAgentInstanceIdentifier }),
    });
    const idempotencyOutcome = evaluateIdempotentSubmission({
      sessionId: input.sessionId,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      inputHash: submissionInputHash,
      findEntry: (key) => ports.findIdempotencyEntry(key),
      hasTaskRecord: (taskIdentifier) => ports.findTaskRecord(taskIdentifier) !== undefined,
    });
    if (idempotencyOutcome.kind === "conflict") {
      throw ports.createPublicError(
        "idempotency-key-conflict",
        "同一 idempotencyKey 绑定了不同参数，拒绝复用: " + String(input.idempotencyKey),
      );
    }
    if (idempotencyOutcome.kind === "claim-pending") {
      throw ports.createPublicError(
        "idempotency-claim-pending",
        "同一 idempotencyKey 的提交仍在进行中，未重复执行: " + String(input.idempotencyKey),
      );
    }
    if (idempotencyOutcome.kind === "reuse-settled") {
      const settledEntry = idempotencyOutcome.entry;
      const settledRecord = ports.findTaskRecord(settledEntry.taskIdentifier);
      if (settledRecord !== undefined) {
        return ports.toTaskResult(settledEntry.taskIdentifier, settledRecord);
      }
      return {
        taskIdentifier: settledEntry.taskIdentifier,
        missionIdentifier: settledEntry.missionIdentifier,
        status: "accepted",
        summaryPreview: null,
      };
    }
    if (idempotencyOutcome.kind === "claim" && input.idempotencyKey !== undefined) {
      await ports.claimIdempotency(idempotencyOutcome.ledgerKey, {
        sessionIdentifier: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        inputHash: submissionInputHash,
        taskIdentifier: input.taskIdentifier,
        missionIdentifier: null,
        claimedAtIso: ports.nowIso(),
        settledAtIso: null,
      });
    }
    const ledgerKey =
      input.idempotencyKey === undefined
        ? null
        : input.sessionId + "|" + input.idempotencyKey;

    /** 既有任务判定（同会话复用 / 跨会话拒绝）。 */
    const existingRecord = ports.findTaskRecord(input.taskIdentifier);
    const existingOutcome = evaluateExistingTaskForSubmission({
      requestedSessionId: input.sessionId,
      ...(existingRecord === undefined
        ? {}
        : { existingTaskSessionId: existingRecord.sessionId }),
    });
    if (existingOutcome.kind === "session-mismatch") {
      throw ports.createPublicError(
        "session-mismatch",
        "任务不属于该会话: " + input.taskIdentifier,
      );
    }
    if (existingOutcome.kind === "reuse" && existingRecord !== undefined) {
      return ports.toTaskResult(input.taskIdentifier, existingRecord);
    }

    if (ports.currentMode() === "ponder") {
      throw ports.createPublicError(
        "invalid-mode-transition",
        "Ponder 模式为本地只读问答，不产生 mission；请使用 handleUserMessage 获取直接回答",
      );
    }
    if (input.targetAgentInstanceIdentifier !== undefined) {
      await ports.validateTargetAgentInstance(input.targetAgentInstanceIdentifier);
    }
    if (input.workspaceRootPath !== undefined) {
      await ports.validateWorkspaceRootPath(input.workspaceRootPath);
    }

    const admission = await ports.admitInstruction(input);
    if (admission.kind === "queued") {
      const queuedRecord: MissionTaskRecordData = {
        sessionId: input.sessionId,
        missionIdentifier: null,
        status: "queued",
        summaryPreview: null,
        revision: 0,
        instructionLink: admission.link,
        queuedPrompt: input.prompt,
      };
      ports.registerTaskRecord(input.taskIdentifier, queuedRecord);
      ports.markTaskQueued(input.taskIdentifier);
      ports.emitTaskStatus({
        taskIdentifier: input.taskIdentifier,
        status: "queued",
        revision: 0,
      });
      return ports.toTaskResult(input.taskIdentifier, queuedRecord);
    }

    const instructionLink = admission.kind === "windowed" ? admission.link : null;
    const missionIdentifier = await ports.submitPromptToController({
      prompt: input.prompt,
      sessionId: input.sessionId,
      ...(input.projectIdentifier === undefined
        ? {}
        : { projectIdentifier: input.projectIdentifier }),
      ...(input.workspaceRootPath === undefined
        ? {}
        : { workspaceRootPath: input.workspaceRootPath }),
      ...(input.targetAgentInstanceIdentifier === undefined
        ? {}
        : { targetAgentInstanceIdentifier: input.targetAgentInstanceIdentifier }),
      ...(input.goalIdentifier === undefined ? {} : { goalIdentifier: input.goalIdentifier }),
    });
    ports.assertOpen();
    const acceptedRecord: MissionTaskRecordData = {
      sessionId: input.sessionId,
      missionIdentifier,
      status: "accepted",
      summaryPreview: null,
      revision: 0,
      instructionLink,
      queuedPrompt: null,
    };
    ports.registerTaskRecord(input.taskIdentifier, acceptedRecord);
    if (ledgerKey !== null) {
      await ports.settleIdempotencyClaim(ledgerKey, missionIdentifier);
    }
    ports.emitTaskStatus({
      taskIdentifier: input.taskIdentifier,
      status: "accepted",
      revision: acceptedRecord.revision,
    });
    ports.startTaskMonitor(input.taskIdentifier);
    return ports.toTaskResult(input.taskIdentifier, acceptedRecord);
  }
  /**
   * 取消任务：终态短路 → 停监视器 → 出队（清 queuedPrompt）→ 取消 mission →
   * 标终态 → 发 task-finished → 释放指令槽位并补一条。
   *
   * 语义与门面原实现逐字一致；状态与副作用全部经端口注入。
   */
  async cancelTask(input: { sessionId: string; taskIdentifier: string }): Promise<void> {
    const ports = this.ports;
    ports.assertOpen();
    ports.requireSession(input.sessionId);
    const record = ports.requireTask(input.taskIdentifier, input.sessionId);
    if (ports.isTerminalStatus(record.status)) {
      return;
    }
    ports.stopTaskMonitor(input.taskIdentifier);
    if (ports.removeQueuedTask(input.taskIdentifier)) {
      record.queuedPrompt = null;
    }
    if (record.missionIdentifier !== null) {
      await ports.cancelMission(record.missionIdentifier);
    }
    record.status = "cancelled";
    ports.emitTaskFinished({
      taskIdentifier: input.taskIdentifier,
      status: "cancelled",
      revision: record.revision,
    });
    await ports.releaseInstructionSlot(record, "cancelled");
  }

}

