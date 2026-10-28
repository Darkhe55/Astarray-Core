/**
 * 反馈进程客户端（主进程侧，T04）。
 * 通过 fork IPC 与独立反馈进程通信；实现 FeedbackTransportPort。
 * 投递消息按 idempotencyKey 去重（同一客户端生命周期内）。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { DomainError } from "../core/errors.js";
import { isProtocolVersionSupported } from "./ipc-protocol.js";
import type { FeedbackIpcMessage } from "./ipc-protocol.js";
import type {
  AgentStatus,
  FeedbackMessage,
  FeedbackTransportPort,
  TransportHealth,
} from "../core/types.js";
import { FEEDBACK_PROTOCOL_VERSION } from "../core/types.js";

export interface ForkFeedbackClientOptions {
  protocolVersion?: number;
  requestTimeoutMilliseconds?: number;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
};

export class ForkFeedbackClient implements FeedbackTransportPort {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly deliveredIdempotencyKeys = new Set<string>();
  private readonly messageHandlerCallbacks: Array<
    (message: FeedbackMessage) => Promise<void> | void
  > = [];
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private disconnected = false;
  /** 是否已发出过 shutdown 请求（幂等收口依据）。 */
  private hasRequestedShutdown = false;
  /**
   * ALIGN-03-06（2026-10-28）：**本地待补送目录**。
   *
   * `enqueue` 先把消息原子落盘，收到子进程 ack 后才删除；发送失败/子进程崩溃时
   * 文件留下，由 `flushPendingOutbox()`（心跳或重连时）补送。
   * 补送靠消息的 `idempotencyKey` 在子进程侧幂等入库，不会重复投递。
   */
  private outboxDirectoryPath: string | null = null;
  private isFlushingOutbox = false;
  private protocolVersion: number;

  constructor(
    private readonly childProcess: ChildProcess,
    private readonly options: ForkFeedbackClientOptions = {},
  ) {
    this.protocolVersion = options.protocolVersion ?? FEEDBACK_PROTOCOL_VERSION;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** 就绪（收到子进程 ready 且协议版本一致）。 */
  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  /** 发送握手消息（由 supervisor 在 fork 后立即调用）。 */
  sendHello(baseDirectory: string, heartbeatTimeoutMilliseconds: number): void {
    /** ALIGN-03-06：补送目录固定在状态目录下（与子进程 mailbox journal 同盘）。 */
    this.outboxDirectoryPath = path.join(baseDirectory, "feedback-client-outbox");
    this.safeSend({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory,
      heartbeatTimeoutMilliseconds,
    });
  }

  /**
   * T12-03：发送心跳（无应答）。子进程以心跳刷新"主进程失联"看门狗；
   * 主进程持续存活时必须按半周期发送，否则子进程会误判失联并自退。
   */
  sendHeartbeat(): void {
    this.safeSend({
      type: "heartbeat",
      timestampUnixMilliseconds: Date.now(),
    });
  }

  onMessage(
    handler: (message: FeedbackMessage) => Promise<void> | void,
  ): void {
    this.messageHandlerCallbacks.push(handler);
  }

  async enqueue(message: FeedbackMessage): Promise<void> {
    /**
     * ALIGN-03-06：**先落盘、后等待就绪、ack 后删除**。
     *
     * 连"子进程还没就绪"的失败也能补送 —— 消息不会因一次失败而丢失；
     * 补送由 `flushPendingOutbox()` 完成，子进程按 `idempotencyKey` 幂等入库。
     */
    await this.persistOutboxMessage(message);
    await this.waitUntilReady();
    const requestId = randomUUID();
    /**
     * 发送失败时**保留 outbox 文件**（交给补送路径），错误如实上抛 —— 不静默吞。
     */
    await this.requestResponse(
      { type: "enqueue", requestId, message },
      requestId,
    );
    await this.removeOutboxMessage(message);
  }

  /**
   * ALIGN-03-06：补送本地 outbox 里未确认的消息。
   *
   * 幂等由子进程的 `idempotencyKey` 去重保证；这里只负责"再发一次"。
   * 单条失败不会中止其余条目的补送（各自保留，下次再试）。
   */
  async flushPendingOutbox(): Promise<{
    attemptedCount: number;
    resentCount: number;
    remainingCount: number;
  }> {
    if (this.outboxDirectoryPath === null || this.isFlushingOutbox) {
      return { attemptedCount: 0, resentCount: 0, remainingCount: 0 };
    }
    this.isFlushingOutbox = true;
    try {
      await this.waitUntilReady().catch(() => undefined);
      let entries: string[];
      try {
        entries = await fs.readdir(this.outboxDirectoryPath);
      } catch {
        return { attemptedCount: 0, resentCount: 0, remainingCount: 0 };
      }
      let attemptedCount = 0;
      let resentCount = 0;
      for (const entryName of entries) {
        if (!entryName.endsWith(".json")) {
          continue;
        }
        attemptedCount += 1;
        const filePath = path.join(this.outboxDirectoryPath, entryName);
        let message: FeedbackMessage | null = null;
        try {
          message = JSON.parse(await fs.readFile(filePath, "utf8")) as FeedbackMessage;
        } catch {
          message = null;
        }
        if (message === null) {
          // 损坏的补送文件：不静默删除（保留现场），计入未发送
          continue;
        }
        const requestId = randomUUID();
        try {
          await this.requestResponse(
            { type: "enqueue", requestId, message },
            requestId,
          );
          await fs.rm(filePath, { force: true }).catch(() => undefined);
          resentCount += 1;
        } catch {
          // 保留文件，下一次补送继续
        }
      }
      let remainingCount = 0;
      try {
        remainingCount = (await fs.readdir(this.outboxDirectoryPath)).filter((name) =>
          name.endsWith(".json"),
        ).length;
      } catch {
        remainingCount = 0;
      }
      return { attemptedCount, resentCount, remainingCount };
    } finally {
      this.isFlushingOutbox = false;
    }
  }

  /** 补送文件路径：按幂等键哈希命名（避免非法字符，且天然去重）。 */
  private outboxFilePathFor(message: FeedbackMessage): string | null {
    if (this.outboxDirectoryPath === null) {
      return null;
    }
    const digest = createHash("sha256")
      .update(message.idempotencyKey)
      .digest("hex")
      .slice(0, 32);
    return path.join(this.outboxDirectoryPath, `${digest}.json`);
  }

  private async persistOutboxMessage(message: FeedbackMessage): Promise<void> {
    const filePath = this.outboxFilePathFor(message);
    if (filePath === null) {
      return;
    }
    await fs.mkdir(this.outboxDirectoryPath as string, { recursive: true });
    /** 原子写（临时文件 + rename），避免半截 JSON 被当补送条目。 */
    const temporaryFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryFilePath, `${JSON.stringify(message, null, 2)}\n`, "utf8");
    await fs.rename(temporaryFilePath, filePath);
  }

  private async removeOutboxMessage(message: FeedbackMessage): Promise<void> {
    const filePath = this.outboxFilePathFor(message);
    if (filePath === null) {
      return;
    }
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }

  setAgentStatus(recipientId: string, status: AgentStatus): void {
    this.safeSend({
      type: "setAgentStatus",
      recipientId,
      status,
    });
  }

  async queryHealth(): Promise<TransportHealth> {
    const requestId = randomUUID();
    const result = await this.requestResponse(
      { type: "health", requestId },
      requestId,
    );
    const healthResult = result as {
      type: "healthResult";
      health: TransportHealth;
    };
    return healthResult.health;
  }

  async requestReplay(recipientId: string): Promise<number> {
    await this.waitUntilReady();
    const requestId = randomUUID();
    const result = await this.requestResponse(
      { type: "replay", requestId, recipientId },
      requestId,
    );
    const replayResult = result as { type: "replayResult"; replayCount: number };
    return replayResult.replayCount;
  }

  async shutdown(): Promise<void> {
    // 幂等：子进程在应答第一个 shutdown 请求后即 `process.exit(0)`，
    // 后续请求**不可能**再有应答。若仍发出新请求，就只能白等到
    // `requestTimeoutMilliseconds`（默认 5_000ms）才吞掉超时 ——
    // 这正是 `ApplicationRuntime.shutdown()` 重复收口时实测到的 5 秒滞留。
    if (this.hasRequestedShutdown) {
      return;
    }
    this.hasRequestedShutdown = true;
    const requestId = randomUUID();
    try {
      await this.requestResponse(
        { type: "shutdown", requestId },
        requestId,
      );
    } catch {
      // 进程已不可达时视为已关闭
    }
  }

  /** 处理来自子进程的入站消息（由 supervisor 注册）。 */
  handleInboundMessage(message: FeedbackIpcMessage): void {
    switch (message.type) {
      case "ready":
        if (!isProtocolVersionSupported(message.protocolVersion)) {
          this.disconnected = true;
          this.rejectReady?.(
            new DomainError(
              "feedback-protocol-mismatch",
              `协议版本不兼容: 子进程 ${message.protocolVersion}，期望 ${FEEDBACK_PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        this.protocolVersion = message.protocolVersion;
        this.disconnected = false;
        this.resolveReady?.();
        break;
      case "deliver":
        this.handleDelivery(message.message);
        break;
      default:
        this.completeRequest(message);
    }
  }

  isDisconnected(): boolean {
    return this.disconnected;
  }

  getProtocolVersion(): number {
    return this.protocolVersion;
  }

  /** 供测试检查去重键数量。 */
  getDeliveredIdempotencyKeyCount(): number {
    return this.deliveredIdempotencyKeys.size;
  }

  private handleDelivery(message: FeedbackMessage): void {
    if (this.deliveredIdempotencyKeys.has(message.idempotencyKey)) {
      this.safeSend({
        type: "ackDelivered",
        requestId: randomUUID(),
        messageId: message.messageId,
      });
      return;
    }
    this.deliveredIdempotencyKeys.add(message.idempotencyKey);
    const handlerResults = this.messageHandlerCallbacks.map((handler) => {
      try {
        return handler(message);
      } catch (error) {
        return Promise.reject(error);
      }
    });
    void Promise.allSettled(handlerResults).then(() => {
      this.safeSend({
        type: "ackDelivered",
        requestId: randomUUID(),
        messageId: message.messageId,
      });
    });
  }

  private completeRequest(message: FeedbackIpcMessage): void {
    if (!("requestId" in message) || message.requestId === null) {
      return;
    }
    const pending = this.pendingRequests.get(message.requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeoutHandle);
    if (message.type === "protocolError") {
      pending.reject(
        new DomainError(
          message.errorCode as never,
          message.errorMessage,
        ),
      );
      return;
    }
    pending.resolve(message);
  }

  private requestResponse(
    outboundMessage: FeedbackIpcMessage,
    requestId: string,
  ): Promise<unknown> {
    if (this.disconnected || !this.childProcess.connected) {
      return Promise.reject(
        new DomainError(
          "feedback-process-unavailable",
          "反馈进程 IPC 已断开，无法发送请求",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timeoutMilliseconds =
        this.options.requestTimeoutMilliseconds ?? 5_000;
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new DomainError(
            "feedback-process-unavailable",
            `反馈进程请求超时（${timeoutMilliseconds}ms）`,
          ),
        );
      }, timeoutMilliseconds);
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });
      this.safeSend(outboundMessage);
    });
  }

  private safeSend(message: FeedbackIpcMessage): void {
    if (this.childProcess.connected) {
      this.childProcess.send(message);
    } else {
      this.disconnected = true;
    }
  }
}
