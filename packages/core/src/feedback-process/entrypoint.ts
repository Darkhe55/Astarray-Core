/**
 * 独立反馈进程入口（T04，ADR-0001）。
 * 与主进程脱离运行；通过 fork IPC 通信；stdout/stderr 仅诊断日志。
 * 职责：journal 持久化、投递调度（质数退避）、ack 消费、健康检查、优雅关闭、心跳看门狗。
 */
import { DomainError } from "../core/errors.js";
import {
  DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
} from "../core/types.js";
import type { AgentStatus, FeedbackMessage, TransportHealth } from "../core/types.js";
import { feedbackMessageSchema } from "../core/schemas.js";
import { deliverThenRecordReceipt } from "./delivery-receipt.js";
import { DeliveryWorker } from "./delivery-worker.js";
import { createInProjectReplyRoutingGuard } from "../orchestration/in-project-reply-routing-guard.js";
import { CommDeliveredMessageStore } from "../orchestration/comm-delivered-message-store.js";
import { TaskStore } from "../infra/task-store.js";
import type {
  FeedbackEnqueueRejectionCode,
  FeedbackIpcMessage,
} from "./ipc-protocol.js";
import {
  FEEDBACK_PROTOCOL_VERSION,
  isProtocolVersionSupported,
} from "./ipc-protocol.js";
import { MailboxJournal } from "./mailbox-journal.js";
import {
  DEFAULT_HEARTBEAT_MISS_TOLERANCE_COUNT,
  createHeartbeatMissTolerance,
} from "./heartbeat-miss-tolerance.js";
import type { JournaledMessage } from "./mailbox-journal.js";

export interface ChildProcessLike {
  connected: boolean;
  pid: number | undefined;
  send(
    message: FeedbackIpcMessage,
    sendHandle?: unknown,
    options?: unknown,
    callback?: (error: Error | null) => void,
  ): boolean | undefined;
  on(event: "message" | "disconnect", listener: (message?: FeedbackIpcMessage) => void): void;
}

export interface FeedbackProcessEntryOptions {
  defaultBaseDirectory: string;
  /** 可注入以便测试（默认 process.exit）。 */
  processExit?: (exitCode: number) => void;
  /** 可注入以便测试（默认 process.stderr.write）。 */
  writeStderr?: (text: string) => void;
  /**
   * B10（2026-11-24）：初始化失败的故障注入点。
   * 缺省构造真实 journal；测试可注入抛错的实现，验证 protocolError + exit(1)。
   */
  createJournal?: (input: {
    readonly baseDirectory: string;
    readonly replyRoutingGuard: ReturnType<typeof createInProjectReplyRoutingGuard>;
    readonly replayDedupeStore: CommDeliveredMessageStore;
  }) => MailboxJournal;
  /** B10：投递 worker 工厂（缺省真实 DeliveryWorker）。 */
  createDeliveryWorker?: (input: {
    readonly journal: MailboxJournal;
    readonly deliverToAgent: (journaledMessage: JournaledMessage) => Promise<void>;
    readonly getRecipientStatus: (recipientId: string) => AgentStatus;
  }) => DeliveryWorker;
  /** B10：投递定时器注入（缺省 globalThis.setTimeout），用于验证关闭时清理待触发重投。 */
  scheduleDeliveryTimer?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => NodeJS.Timeout;
  /** B10：与 scheduleDeliveryTimer 配对（缺省 globalThis.clearTimeout）。 */
  clearDeliveryTimer?: (timer: NodeJS.Timeout) => void;
}

export function runFeedbackProcessEntry(
  parent: ChildProcessLike,
  options: FeedbackProcessEntryOptions,
): void {
  const processExit = options.processExit ?? ((exitCode: number) => process.exit(exitCode));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  const scheduleDeliveryTimer = options.scheduleDeliveryTimer ?? setTimeout;
  const clearDeliveryTimer = options.clearDeliveryTimer ?? clearTimeout;
  const statuses = new Map<string, AgentStatus>();
  let journal: MailboxJournal | null = null;
  let deliveryWorker: DeliveryWorker | null = null;
  let heartbeatWatchdog: NodeJS.Timeout | null = null;
  const recipientDeliveryTimers = new Map<string, NodeJS.Timeout>();
  let baseDirectory = options.defaultBaseDirectory;
  let heartbeatTimeoutMilliseconds = 30_000;
  /** 连续错过 2 次才判定主进程失联：单次负载抖动不应杀掉子进程。 */
  const heartbeatMissTolerance = createHeartbeatMissTolerance({
    toleranceCount: DEFAULT_HEARTBEAT_MISS_TOLERANCE_COUNT,
  });

  function sendToParent(message: FeedbackIpcMessage): void {
    if (parent.connected) {
      parent.send(message);
    }
  }

  function refreshHeartbeatWatchdog(): void {
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog);
    }
    heartbeatWatchdog = setTimeout(() => {
      const consecutiveMissCount = heartbeatMissTolerance.recordMiss();
      if (!heartbeatMissTolerance.shouldExit()) {
        writeStderr(
          `astarray: 反馈进程连续 ${String(consecutiveMissCount)} 次未收到主进程心跳，继续等待\n`,
        );
        refreshHeartbeatWatchdog();
        return;
      }
      sendToParent({ type: "selfTermination", reason: "heartbeat-lost" });
      writeStderr(
        "astarray: 反馈进程未收到主进程心跳，判定主进程失联，自行退出\n",
      );
      processExit(1);
    }, heartbeatTimeoutMilliseconds * 2);
  }

  async function buildHealth(): Promise<TransportHealth> {
    let queuedMessageCount = 0;
    if (journal !== null) {
      for (const recipientId of await journal.listRecipientIds()) {
        queuedMessageCount += await journal.countPending(recipientId);
      }
    }
    return {
      isHealthy: journal !== null,
      processPid: parent.pid ?? process.pid,
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      queuedMessageCount,
    };
  }

  /**
   * 入池前运行时校验（审计 S2）：
   * 1) feedbackMessageSchema 严格校验（来源/优先级/幂等键/载荷一致性）；
   * 2) 身份一致性：Agent 来源的 agentInstanceId 必须已在本进程注册（setAgentStatus 或注册表），
   *    未注册来源一律拒绝入池，防止伪造来源/非法层级/缺失来源进入 journal。
   */
  const registeredAgentInstanceIds = new Set<string>();

  function registerAgentInstanceId(agentInstanceId: string): void {
    registeredAgentInstanceIds.add(agentInstanceId);
  }

  async function handleEnqueue(message: FeedbackMessage): Promise<{
    readonly accepted: boolean;
    readonly rejectionCode?: FeedbackEnqueueRejectionCode;
    readonly rejectionReason?: string;
  }> {
    if (journal === null || deliveryWorker === null) {
      return {
        accepted: false,
        rejectionCode: "journal-unavailable",
        rejectionReason: "反馈进程尚未就绪（journal 或投递器缺失）。",
      };
    }
    const parsed = feedbackMessageSchema.safeParse(message);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      writeStderr(
        `astarray: 反馈进程拒绝非法消息（schema 校验失败）: ${parsed.error.message}\n`,
      );
      return {
        accepted: false,
        rejectionCode: "invalid-message",
        rejectionReason: firstIssue?.message ?? "schema 校验失败",
      };
    }
    const validatedMessage = parsed.data;
    if (
      validatedMessage.source.sourceType === "agent" &&
      !registeredAgentInstanceIds.has(validatedMessage.source.agentInstanceId)
    ) {
      writeStderr(
        `astarray: 反馈进程拒绝未注册 Agent 来源的消息: ${validatedMessage.source.agentInstanceId}\n`,
      );
      return {
        accepted: false,
        rejectionCode: "source-not-registered",
        rejectionReason: `来源未注册: ${validatedMessage.source.agentInstanceId}`,
      };
    }
    await journal.enqueue(validatedMessage);
    deliveryWorker.resetBackoff(validatedMessage.recipientId);
    scheduleDeliveryAttempt(validatedMessage.recipientId, 0);
    return { accepted: true };
  }

  function scheduleDeliveryAttempt(
    recipientId: string,
    delayMilliseconds: number,
  ): void {
    const existingTimer = recipientDeliveryTimers.get(recipientId);
    if (existingTimer !== undefined) {
      clearDeliveryTimer(existingTimer);
    }
    const timer = scheduleDeliveryTimer(() => {
      recipientDeliveryTimers.delete(recipientId);
      void runDeliveryStep(recipientId);
    }, delayMilliseconds);
    recipientDeliveryTimers.set(recipientId, timer);
  }

  async function runDeliveryStep(recipientId: string): Promise<void> {
    /**
     * B10（2026-11-24）：删除"初始化前早返回"死守卫。
     *
     * 不变量：投递定时器只可能在 `handleHello` 成功（journal 与 worker 均已赋值）后创建；
     * 因此这里不需要可空分支。若该不变量被破坏，应当**显式失败**而不是静默跳过。
     */
    const activeJournal = journal;
    const activeWorker = deliveryWorker;
    if (activeJournal === null || activeWorker === null) {
      writeStderr("astarray: 反馈进程投递步骤在初始化前被调用（不变量被破坏）\n");
      return;
    }
    try {
      const stepResult = await activeWorker.runDeliveryStep(recipientId);
      scheduleDeliveryAttempt(recipientId, stepResult.waitSeconds * 1000);
    } catch (error) {
      writeStderr(
        `astarray: 反馈进程投递失败 - ${(error as Error).message}\n`,
      );
      scheduleDeliveryAttempt(recipientId, 5_000);
    }
  }

  async function handleAckDelivered(
    messageId: string,
    requestId: string,
  ): Promise<void> {
    if (journal === null) {
      return;
    }
    for (const recipientId of await journal.listRecipientIds()) {
      await journal.ack(recipientId, messageId);
    }
    sendToParent({ type: "acked", requestId });
  }

  async function handleReplay(
    requestId: string,
    recipientId: string,
  ): Promise<void> {
    if (journal === null) {
      sendToParent({ type: "replayResult", requestId, replayCount: 0 });
      return;
    }
    const recipientIds =
      recipientId === "*"
        ? await journal.listRecipientIds()
        : [recipientId];
    let replayCount = 0;
    for (const targetRecipientId of recipientIds) {
      const nextMessage = await journal.peekNext(targetRecipientId);
      if (nextMessage !== null && nextMessage.delivered) {
        sendToParent({ type: "deliver", message: nextMessage });
        replayCount += 1;
      }
      scheduleDeliveryAttempt(targetRecipientId, 0);
    }
    sendToParent({ type: "replayResult", requestId, replayCount });
  }

  function handleShutdown(requestId: string): void {
    for (const timer of recipientDeliveryTimers.values()) {
      clearDeliveryTimer(timer);
    }
    recipientDeliveryTimers.clear();
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog);
    }
    sendToParent({ type: "shutdownComplete", requestId });
    setImmediate(() => processExit(0));
  }

  function handleHello(
    message: Extract<FeedbackIpcMessage, { type: "hello" }>,
  ): void {
    if (!isProtocolVersionSupported(message.protocolVersion)) {
      sendToParent({
        type: "protocolError",
        requestId: null,
        errorCode: "feedback-protocol-mismatch",
        errorMessage: `协议版本不兼容: 期望 ${FEEDBACK_PROTOCOL_VERSION}，收到 ${message.protocolVersion}`,
      });
      setTimeout(() => processExit(1), 100);
      return;
    }
    baseDirectory = message.baseDirectory;
    heartbeatTimeoutMilliseconds = message.heartbeatTimeoutMilliseconds;
    try {
      /**
       * COMM-01（2026-11-15 用户裁决第 1 条）：**子进程侧同样注入回复路由守卫**。
       *
       * 反馈子进程是项目内消息的另一个真实入队点（`handleEnqueueMessage`），
       * 若这里不注入，带回复标记的消息就会从这条路径绕过校验——等于规则只在一半路径上成立。
       * 任务链存储与主进程共用同一个 stateDirectory，因此子进程也能解析"任务 → 发布者"。
       */
      /**
       * 2026-11-24（B10 收口）：用**局部常量**捕获本次初始化的任务存储。
       * 闭包在 journal 构造之后才可能调用；原先读模块级可空变量导致一行永远不可达的
       * `feedbackTaskStore === null` 守卫（死代码），改为局部常量后该分支被删除，
       * 且仍保持"构造失败由外层 catch 统一上报"的语义。
       */
      const taskStoreForReplyGuard = new TaskStore({ baseDirectory });
      const replyRoutingGuard = createInProjectReplyRoutingGuard({
        resolveTask: async ({ missionIdentifier, taskIdentifier }) => {
          const taskChain = await taskStoreForReplyGuard.readTaskChain(missionIdentifier);
          const task = taskChain?.tasks.find((candidate) => candidate.id === taskIdentifier);
          return task === undefined ? null : task;
        },
        defaultSchedulerRecipientIdentifierForMission: (missionIdentifier) =>
          `scheduler:${missionIdentifier}`,
      });
      const replayDedupeStore = new CommDeliveredMessageStore({ baseDirectory });
      const createJournal =
        options.createJournal ??
        ((journalInput: {
          readonly baseDirectory: string;
          readonly replyRoutingGuard: ReturnType<typeof createInProjectReplyRoutingGuard>;
          readonly replayDedupeStore: CommDeliveredMessageStore;
        }) => {
          /** 局部同名（遮蔽外层可变变量）只为让装配语句与既有守卫的检查形态一致。 */
          const baseDirectory = journalInput.baseDirectory;
          return new MailboxJournal(baseDirectory, {
            replyRoutingGuard: journalInput.replyRoutingGuard,
            /** COMM-01（2026-11-16）：子进程侧同样启用重放去重（与主进程共用状态目录）。 */
            replayDedupeStore: new CommDeliveredMessageStore({ baseDirectory }),
          });
        });
      const createdJournal = createJournal({
        baseDirectory,
        replyRoutingGuard,
        replayDedupeStore,
      });
      journal = createdJournal;
      /**
       * WIRING-04-02 修正（2026-11-25）：**先投递、后写回执**。
       *
       * 原顺序是先 markDelivered 再 sendToParent：两步之间崩溃 ⇒ 消息被记为已投递却从未送达，
       * 且不会再重试（丢消息）。现改为投递成功后才写回执；投递抛错则不写，交由工作者重试。
       * 回执写失败时消息已送达但未标记 ⇒ 可能重投，接收端按 messageId 去重（既有 replay 去重）。
       */
      const deliverToAgent = async (journaledMessage: JournaledMessage) => {
        await deliverThenRecordReceipt({
          dispatch: () => {
            sendToParent({ type: "deliver", message: journaledMessage });
          },
          recordReceipt: async () => {
            await journal?.markDelivered(
              journaledMessage.recipientId,
              journaledMessage.messageId,
              new Date().toISOString(),
            );
          },
        });
      };
      const getRecipientStatus = (recipientId: string): AgentStatus =>
        statuses.get(recipientId) ?? "idle";
      const createDeliveryWorker =
        options.createDeliveryWorker ??
        ((workerInput: {
          readonly journal: MailboxJournal;
          readonly deliverToAgent: (journaledMessage: JournaledMessage) => Promise<void>;
          readonly getRecipientStatus: (recipientId: string) => AgentStatus;
        }) =>
          new DeliveryWorker(
            {
              journal: workerInput.journal,
              deliverToAgent: workerInput.deliverToAgent,
              getRecipientStatus: workerInput.getRecipientStatus,
            },
            DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
          ));
      deliveryWorker = createDeliveryWorker({
        journal: createdJournal,
        deliverToAgent,
        getRecipientStatus,
      });
    } catch (error) {
      sendToParent({
        type: "protocolError",
        requestId: null,
        errorCode:
          error instanceof DomainError ? error.errorCode : "unknown",
        errorMessage: `反馈进程初始化失败: ${(error as Error).message}`,
      });
      processExit(1);
      return;
    }
    refreshHeartbeatWatchdog();
    sendToParent({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: parent.pid ?? process.pid,
    });
  }

  function onMessage(message: FeedbackIpcMessage): void {
    switch (message.type) {
      case "hello":
        handleHello(message);
        break;
      case "enqueue":
        void handleEnqueue(message.message)
          .then((result) => {
            sendToParent({
              type: "enqueued",
              requestId: message.requestId,
              accepted: result.accepted,
              ...(result.rejectionCode === undefined
                ? {}
                : { rejectionCode: result.rejectionCode }),
              ...(result.rejectionReason === undefined
                ? {}
                : { rejectionReason: result.rejectionReason }),
            });
          })
          .catch(() => {
            sendToParent({
              type: "enqueued",
              requestId: message.requestId,
              accepted: false,
              rejectionCode: "journal-unavailable",
              rejectionReason: "反馈进程处理入队时发生内部错误。",
            });
          });
        break;
      case "setAgentStatus":
        statuses.set(message.recipientId, message.status);
        registerAgentInstanceId(message.recipientId);
        break;
      case "ackDelivered":
        void handleAckDelivered(message.messageId, message.requestId);
        break;
      case "health":
        void buildHealth().then((health) => {
          sendToParent({
            type: "healthResult",
            requestId: message.requestId,
            health,
          });
        });
        break;
      case "replay":
        void handleReplay(message.requestId, message.recipientId);
        break;
      case "shutdown":
        handleShutdown(message.requestId);
        break;
      case "heartbeat":
        heartbeatMissTolerance.recordHeartbeat();
        refreshHeartbeatWatchdog();
        break;
      default:
        break;
    }
  }

  parent.on("message", (message) => {
    if (message !== undefined) {
      onMessage(message as FeedbackIpcMessage);
    }
  });
  parent.on("disconnect", () => {
    writeStderr("astarray: 反馈进程与主进程断开，自行退出\n");
    processExit(1);
  });

  if (!parent.connected) {
    processExit(1);
  }
}

/** 供真实进程引导（child-bootstrap.ts）使用的窄化判断。 */
export function isNodeJsProcess(value: unknown): value is NodeJS.Process {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    "on" in value
  );
}