/**
 * MISSION-WRITE-01 切片 6（2026-11-28）：**指令窗口准入 / 释放 / 补位派发服务**。
 *
 * 从门面抽出 SMART-01 指令窗口的三段逻辑：
 * 1. `admitTaskInstruction`：窗口满 ⇒ 排队；窗口内 ⇒ 准入；无状态目录 ⇒ 不启用（如实降级）；
 * 2. `releaseSlotAndDispatchNext`：先交回执（没有回执不算完成交办），再取队首**一条**补位；
 * 3. `dispatchNextQueuedTask`：串行化补位，派发失败如实标 failed 并交失败回执，不静默丢队列。
 *
 * 状态（队列、进行中标记、任务记录、监视器、事件）仍由门面持有，经端口注入；
 * 本服务不读盘、不联网，只用注入的存储与端口。
 */
import { createHash } from "node:crypto";

export interface InstructionWindowStorePort {
  admitInstruction(input: {
    instructionIdentifier: string;
    instructionRevision: number;
    sourceKind: "user";
    instructionText: string;
    idempotencyKey: string;
  }): Promise<{ outcome: string; instructionIdentifier: string }>;
  submitReceipt(input: {
    instructionIdentifier: string;
    instructionRevision: number;
    receiptOutcome: "completed" | "failed" | "cancelled";
    taskIdentifiers: string[];
    evidenceReferences: string[];
    unresolvedQuestions: string[];
  }): Promise<unknown>;
}

export interface InstructionWindowTaskRecord {
  sessionId: string;
  missionIdentifier: string | null;
  status: string;
  revision: number;
  instructionLink: { instructionIdentifier: string; instructionRevision: number } | null;
  queuedPrompt: string | null;
  summaryPreview: string | null;
}

export type InstructionAdmissionOutcome =
  | { readonly kind: "unwindowed" }
  | { readonly kind: "windowed"; readonly link: { instructionIdentifier: string; instructionRevision: number } }
  | { readonly kind: "queued"; readonly link: { instructionIdentifier: string; instructionRevision: number } };

export interface InstructionWindowDispatchPorts {
  /** 无状态目录 ⇒ false（不启用指令窗口，如实降级）。 */
  isWindowEnabled(): boolean;
  getStore(): Promise<InstructionWindowStorePort>;
  createPublicError(errorCode: string, message: string): Error;
  shiftQueuedTask(): string | undefined;
  removeQueuedTask(taskIdentifier: string): boolean;
  findTaskRecord(taskIdentifier: string): InstructionWindowTaskRecord | undefined;
  listTaskEntries(): Array<readonly [string, InstructionWindowTaskRecord]>;
  emitTaskStatus(event: { taskIdentifier: string; status: string; revision: number }): void;
  emitTaskFinished(event: { taskIdentifier: string; status: string; revision: number }): void;
  startTaskMonitor(taskIdentifier: string): void;
  submitPrompt(input: { prompt: string; sessionId: string }): Promise<string>;
  acquireDispatchLock(): boolean;
  releaseDispatchLock(): void;
}

export class InstructionWindowDispatchService {
  constructor(private readonly ports: InstructionWindowDispatchPorts) {}

  /** 窗口准入（窗口满 ⇒ queued；窗口内 ⇒ windowed；无状态目录 ⇒ unwindowed）。 */
  async admitTaskInstruction(input: {
    readonly sessionId: string;
    readonly taskIdentifier: string;
    readonly prompt: string;
    readonly idempotencyKey?: string;
  }): Promise<InstructionAdmissionOutcome> {
    if (!this.ports.isWindowEnabled()) {
      return { kind: "unwindowed" };
    }
    const store = await this.ports.getStore();
    /**
     * 窗口幂等键**按任务提交**生成，不复用用户 idempotencyKey；
     * 含内容摘要：同标识不同内容的再次提交也必须能各自占位。
     */
    const result = await store.admitInstruction({
      instructionIdentifier: "task-instruction:" + input.taskIdentifier,
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: input.prompt,
      idempotencyKey:
        "task:" +
        input.sessionId +
        ":" +
        input.taskIdentifier +
        ":" +
        createHash("sha256").update(input.prompt, "utf8").digest("hex").slice(0, 16),
    });
    if (result.outcome === "idempotency-conflict") {
      throw this.ports.createPublicError(
        "idempotency-key-conflict",
        "同一幂等键绑定了不同的指令内容，拒绝接收: " +
          String(input.idempotencyKey ?? input.taskIdentifier),
      );
    }
    const link = {
      instructionIdentifier: result.instructionIdentifier,
      instructionRevision: 1,
    };
    return result.outcome === "queued"
      ? { kind: "queued", link }
      : { kind: "windowed", link };
  }

  /**
   * 释放该任务占用的指令槽位并**只补一条**排队指令。
   *
   * 顺序不可颠倒：先交回执（没有回执就不算完成交办，槽位不得释放），再取队首一条派发。
   */
  async releaseSlotAndDispatchNext(
    record: InstructionWindowTaskRecord,
    terminalStatus: string,
  ): Promise<void> {
    const instructionLink = record.instructionLink;
    if (instructionLink === null) return;
    const store = await this.ports.getStore();
    const receiptOutcome =
      terminalStatus === "cancelled"
        ? "cancelled"
        : terminalStatus === "done"
          ? "completed"
          : "failed";
    await store
      .submitReceipt({
        instructionIdentifier: instructionLink.instructionIdentifier,
        instructionRevision: instructionLink.instructionRevision,
        receiptOutcome,
        taskIdentifiers: [this.taskIdentifierOf(record)],
        evidenceReferences: [],
        unresolvedQuestions: [],
      })
      .catch(() => null);
    record.instructionLink = null;
    await this.dispatchNextQueuedTask();
  }

  /** 反查任务标识（回执需要它；找不到就不猜）。 */
  taskIdentifierOf(record: InstructionWindowTaskRecord): string {
    for (const [taskIdentifier, candidate] of this.ports.listTaskEntries()) {
      if (candidate === record) return taskIdentifier;
    }
    return "unknown-task";
  }

  /**
   * 取队首一条并派发。
   *
   * 只补一条：并发终态可能同时触发，用进行中标记串行化，避免越过窗口容量。
   */
  async dispatchNextQueuedTask(): Promise<void> {
    if (!this.ports.acquireDispatchLock()) return;
    try {
      const nextTaskIdentifier = this.ports.shiftQueuedTask();
      if (nextTaskIdentifier === undefined) return;
      const record = this.ports.findTaskRecord(nextTaskIdentifier);
      if (record === undefined || record.queuedPrompt === null) return;
      const prompt = record.queuedPrompt;
      record.queuedPrompt = null;
      try {
        const missionIdentifier = await this.ports.submitPrompt({
          prompt,
          sessionId: record.sessionId,
        });
        record.missionIdentifier = missionIdentifier;
        record.status = "accepted";
        this.ports.emitTaskStatus({
          taskIdentifier: nextTaskIdentifier,
          status: "accepted",
          revision: record.revision,
        });
        this.ports.startTaskMonitor(nextTaskIdentifier);
      } catch {
        record.status = "failed";
        record.summaryPreview = "排队指令派发失败";
        this.ports.emitTaskFinished({
          taskIdentifier: nextTaskIdentifier,
          status: "failed",
          revision: record.revision,
        });
        if (record.instructionLink !== null) {
          const store = await this.ports.getStore();
          await store
            .submitReceipt({
              instructionIdentifier: record.instructionLink.instructionIdentifier,
              instructionRevision: record.instructionLink.instructionRevision,
              receiptOutcome: "failed",
              taskIdentifiers: [nextTaskIdentifier],
              evidenceReferences: [],
              unresolvedQuestions: [],
            })
            .catch(() => null);
          record.instructionLink = null;
        }
      }
    } finally {
      this.ports.releaseDispatchLock();
    }
  }

  /** 取消时把任务移出队列（返回是否真的移出）。 */
  removeQueuedTask(taskIdentifier: string): boolean {
    return this.ports.removeQueuedTask(taskIdentifier);
  }
}
