#!/usr/bin/env node
/**
 * COMM-01-03 多实例离线闭环（tarball）验收（2026-10-22）。
 *
 * 用法：node scripts/verify-comm-package.mjs --package-dir <已安装包目录>
 *
 * 判据（卡内："公共入口真实多实例离线闭环、**独立进程**和**重启证据**、tarball 隔离安装通过"）：
 * 1. **真实独立进程**：fork `dist/feedback-process-entry.js`（不是在测试进程里 mock）；
 * 2. 通过版本化 IPC 完成 `hello → enqueue → deliver`；
 * 3. **崩溃不丢**：收到 `deliver` 后**故意不 ack** 直接 kill，重启后 `replay` **重放同一条**；
 * 4. **ack 后不重复**：确认后再 `replay` 不再返回该条；
 * 5. **接收者隔离**：另一个接收者只收到自己的消息；
 * 6. **优雅关闭**：`shutdown → shutdownComplete`；
 * 7. 全程**离线**：只读写本地 journal，不启动网络监听。
 */
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory = argv[index + 1] === undefined ? null : path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法: node scripts/verify-comm-package.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const entryPath = path.join(packageRoot, "dist", "feedback-process-entry.js");
try {
  await fs.access(entryPath);
} catch {
  process.stderr.write(`未找到反馈进程入口：${entryPath}\n`);
  process.exit(2);
}

// 父进程也直接使用 SDK（跨项目只读传输段）：注意这里要 public-sdk，不是反馈进程入口
const sdkEntryPath = path.join(packageRoot, "dist", "public-sdk.js");
const sdk = await import(new URL(`file://${sdkEntryPath.replaceAll("\\", "/")}`).href);
const PROTOCOL_VERSION = 1;
let currentStage = "init";
function stage(name) {
  currentStage = name;
  process.stderr.write(`[comm-e2e] stage: ${name}\n`);
}
const failures = [];
const observations = {};
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm-e2e-"));

function startFeedbackProcess() {
  const child = fork(entryPath, [], {
    env: {
      ...process.env,
      ASTARRAY_FEEDBACK_CHILD: "1",
      ASTARRAY_STATE_DIRECTORY: stateDirectory,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

function waitForMessage(child, predicate, timeoutMilliseconds = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`等待 IPC 消息超时（stage=${currentStage}）`));
    }, timeoutMilliseconds);
    function onMessage(rawMessage) {
      const message = rawMessage;
      if (predicate(message)) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        resolve(message);
      }
    }
    child.on("message", onMessage);
    child.once("exit", (code) => {
      // 崩溃场景下进程主动退出：只清理定时器，由调用方继续等待重启后的消息。
      if (code !== null && code !== 0 && predicate.type !== undefined) {
        // 忽略：调用方会在新进程上等待。
      }
    });
  });
}

function send(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

// 稳定映射：序号 → UUID（schema 要求 messageId 为 UUID；断言仍用序号）
const messageIdentifiersBySequence = new Map();

function messageIdentifierFor(sequence) {
  const existing = messageIdentifiersBySequence.get(sequence);
  if (existing !== undefined) return existing;
  const created = randomUUID();
  messageIdentifiersBySequence.set(sequence, created);
  return created;
}

function message(recipientId, sequence) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: messageIdentifierFor(sequence),
    // 真实契约：source 是 sourceType 判别联合；priority 必须与 payload.kind 对应
    source: { sourceType: "agent", agentInstanceId: "agent-a", agentRole: "main" },
    recipientId,
    priority: "instruction",
    createdAtIso: "2026-10-22T10:00:00.000Z",
    idempotencyKey: `idem-${String(sequence)}`,
    payload: { kind: "instruction", instructionText: `离线消息 ${String(sequence)}` },
  };
}

/** 把断言里的 "msg-N" 换成真实 UUID。 */
function identifier(sequence) {
  return messageIdentifierFor(sequence);
}

async function openSession({ recipients, messages }) {
  stage("open-session");
  const child = startFeedbackProcess();
  // 先注册监听再发送：IPC 回包可能早于 await send 的续体
  const readyPromise = waitForMessage(child, (incoming) => incoming.type === "ready");
  await send(child, {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    baseDirectory: stateDirectory,
    heartbeatTimeoutMilliseconds: 30_000,
  });
  stage("hello");
  await readyPromise;
  stage("ready");
  // 注意：来源 Agent 也必须先注册（入口会拒绝未注册来源的消息）
  for (const recipientId of ["agent-a", ...recipients]) {
    await send(child, { type: "setAgentStatus", recipientId, status: "idle" });
  }
  stage("enqueue");
  let requestIndex = 0;
  for (const item of messages) {
    requestIndex += 1;
    const requestId = `enqueue-${String(requestIndex)}`;
    const enqueuedPromise = waitForMessage(
      child,
      (incoming) => incoming.type === "enqueued" && incoming.requestId === requestId,
    );
    await send(child, { type: "enqueue", requestId, message: item });
    const enqueued = await enqueuedPromise;
    if (enqueued.accepted !== true) failures.push(`入池被拒：${item.messageId}`);
  }
  return child;
}

function replay(child, recipientId, requestId) {
  return send(child, { type: "replay", requestId, recipientId });
}

function ack(child, messageId, requestId) {
  return send(child, { type: "ackDelivered", requestId, messageId });
}

try {
  // ① 第一个进程：入池 msg-1..3（给 agent-b）+ msg-c1（给 agent-c），收到 msg-1 投递后**不 ack 就崩溃**
  const firstProcess = await openSession({
    recipients: ["agent-b", "agent-c"],
    messages: [message("agent-b", 1), message("agent-b", 2), message("agent-b", 3), message("agent-c", 101)],
  });
  const firstDelivery = await waitForMessage(
    firstProcess,
    (incoming) =>
      incoming.type === "deliver" && incoming.message.recipientId === "agent-b",
  );
  observations.firstDeliveredMessage = `msg-1 (${firstDelivery.message.messageId})`;
  if (firstDelivery.message.messageId !== identifier(1)) {
    failures.push(`首次投递应为 msg-1，实际 ${String(firstDelivery.message.messageId)}`);
  }
  // 不 ack，直接 kill（模拟崩溃：消息已 markDelivered 但未确认）
  firstProcess.kill("SIGKILL");
  await new Promise((resolve) => firstProcess.once("exit", resolve));

  // ② 重启进程：replay 必须重放未被 ack 的 msg-1
  const secondProcess = await openSession({ recipients: ["agent-b"], messages: [] });
  const replayedPromise = waitForMessage(
    secondProcess,
    (incoming) => incoming.type === "deliver" && incoming.message.recipientId === "agent-b",
  );
  await replay(secondProcess, "agent-b", "replay-1");
  const replayed = await replayedPromise;
  observations.replayedMessage = `msg-1 (${replayed.message.messageId})`;
  if (replayed.message.messageId !== identifier(1)) {
    failures.push(`重启后 replay 应重放 msg-1（崩溃不丢），实际 ${String(replayed.message.messageId)}`);
  }

  // ③ ack 后 replay 不再返回 msg-1
  await ack(secondProcess, identifier(1), "ack-1");
  await waitForMessage(
    secondProcess,
    (incoming) => incoming.type === "acked" && incoming.requestId === "ack-1",
  );
  await replay(secondProcess, "agent-b", "replay-2");
  const afterAck = await waitForMessage(
    secondProcess,
    (incoming) => incoming.type === "deliver" && incoming.message.recipientId === "agent-b",
    5_000,
  ).catch(() => null);
  observations.afterAckDelivered = afterAck?.message.messageId ?? null;
  if (afterAck !== null && afterAck.message.messageId === identifier(1)) {
    failures.push("ack 之后 replay 不得再返回 msg-1（重复投递）");
  }

  // ④ 接收者隔离：agent-c 的 replay 只返回自己的消息
  await replay(secondProcess, "agent-c", "replay-3");
  const otherRecipient = await waitForMessage(
    secondProcess,
    (incoming) => incoming.type === "deliver" && incoming.message.recipientId === "agent-c",
  );
  observations.otherRecipientMessage = `msg-c1 (${otherRecipient.message.messageId})`;
  if (otherRecipient.message.messageId !== identifier(101)) {
    failures.push(`agent-c 应只收到 msg-c1，实际 ${String(otherRecipient.message.messageId)}`);
  }

  // ⑤ 优雅关闭
  await send(secondProcess, { type: "shutdown", requestId: "shutdown-1" });
  const shutdownComplete = await waitForMessage(
    secondProcess,
    (incoming) => incoming.type === "shutdownComplete" && incoming.requestId === "shutdown-1",
  );
  observations.shutdownCompleted = shutdownComplete.type === "shutdownComplete";
  await new Promise((resolve) => secondProcess.once("exit", resolve));

  // ⑥ 持久化核对：journal 文件存在且只保留未 ack 的消息
  const journalPath = path.join(stateDirectory, "feedback", "mailboxes", "agent-b.json");
  const journalDocument = JSON.parse(await fs.readFile(journalPath, "utf8"));
  observations.rawJournalMessages = journalDocument.messages.map((entry) => ({
    id: entry.messageId,
    delivered: entry.delivered,
    sequence: entry.enqueuedSequence,
  }));
  const remainingIdentifiers = journalDocument.messages.map((entry) => entry.messageId);
  observations.remainingAgentB = remainingIdentifiers;
  if (remainingIdentifiers.includes(identifier(1))) failures.push("已 ack 的 msg-1 不应留在 journal");
  if (!remainingIdentifiers.includes(identifier(2)) || !remainingIdentifiers.includes(identifier(3))) {
    failures.push("未确认的 msg-2/msg-3 必须仍在 journal（重启不丢）");
  }

  // ⑦ 跨项目只读传输（COMM-01-02）：授权 → 发送 → 幂等抑制
  stage("cross-project");
  const crossProjectStateDirectory = path.join(stateDirectory, "cross-project-state");
  const crossProjectJournal = new sdk.MailboxJournal(crossProjectStateDirectory);
  const grantOutcome = sdk.issueCrossProjectAuthorization({
    authorizationIdentifier: "auth-e2e",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    requestingAgentInstanceId: "agent-a1",
    grantor: { kind: "authenticated-user", userId: "user-1" },
    scope: { kind: "specific-agent", agentInstanceId: "agent-b1" },
    allowedMessageKinds: ["status-query", "correlated-reply"],
    purpose: "只读状态查询",
    issuedAtIso: "2026-10-22T10:00:00.000Z",
    expiresAtIso: "2026-10-23T10:00:00.000Z",
    revision: 1,
  });
  if (grantOutcome.kind !== "granted") failures.push("跨项目授权签发失败");
  const crossProjectEnvelope = {
    messageIdentifier: randomUUID(),
    idempotencyKey: "idem-e2e-1",
    senderAgentInstanceId: "agent-a1",
    recipientAgentInstanceId: "agent-b1",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    sourceSessionIdentifier: "session-a",
    targetSessionIdentifier: null,
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    authorizationRevision: 1,
    messageKind: "status-query",
    correlationIdentifier: null,
    replyToMessageIdentifier: null,
    intendedAction: "read",
  };
  const crossProjectSend = await sdk.sendCrossProjectMessage({
    baseDirectory: crossProjectStateDirectory,
    journal: crossProjectJournal,
    envelope: crossProjectEnvelope,
    authorization: grantOutcome.kind === "granted" ? grantOutcome.authorization : null,
    nowIso: "2026-10-22T12:00:00.000Z",
  });
  observations.crossProjectSend = crossProjectSend.kind;
  if (crossProjectSend.kind !== "queued") failures.push("跨项目只读消息应入池");
  const crossProjectDuplicate = await sdk.sendCrossProjectMessage({
    baseDirectory: crossProjectStateDirectory,
    journal: crossProjectJournal,
    envelope: { ...crossProjectEnvelope, messageIdentifier: randomUUID() },
    authorization: grantOutcome.kind === "granted" ? grantOutcome.authorization : null,
    nowIso: "2026-10-22T12:00:00.000Z",
  });
  observations.crossProjectDuplicate = crossProjectDuplicate.kind;
  if (crossProjectDuplicate.kind !== "duplicate-suppressed") {
    failures.push("同幂等键的跨项目消息应被抑制");
  }
  if ((await crossProjectJournal.countPending("agent-b1")) !== 1) {
    failures.push("跨项目消息只应入池一次");
  }
  const crossProjectWriteAttempt = await sdk.sendCrossProjectMessage({
    baseDirectory: crossProjectStateDirectory,
    journal: crossProjectJournal,
    envelope: { ...crossProjectEnvelope, idempotencyKey: "idem-e2e-2", intendedAction: "write-file" },
    authorization: grantOutcome.kind === "granted" ? grantOutcome.authorization : null,
    nowIso: "2026-10-22T12:00:00.000Z",
  });
  observations.crossProjectWriteAttempt = crossProjectWriteAttempt.kind;
  if (crossProjectWriteAttempt.kind !== "rejected") failures.push("跨项目写动作必须被拒");
  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        observations,
        failures,
      },
      null,
      2,
    )}\n`,
  );
  // ── COMM-01-03 新增只读入口的包级验收（2026-10-24）────────────────────
  // 1) `collaboration status --json`：只读、空状态写「空 ≠ 不存在」；
  // 2) `inbox list --json`：未保存过写「空 ≠ 无消息」；
  // 3) `inbox deliver --json`：无收件箱 ⇒ 退出码 2（不伪造投递）；
  // 4) 以上命令前后，状态目录里的文件清单不变（只读）。
  const cliPath = path.join(options.packageDirectory, "dist", "cli.js");
  const cliCwd = stateDirectory;
  const listStateFiles = async () => {
    const collected = [];
    const walk = async (directoryPath) => {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
        } else {
          collected.push(absolutePath);
        }
      }
    };
    await walk(stateDirectory);
    return collected.sort();
  };
  const runCli = (argumentsList) =>
    spawnSync(process.execPath, [cliPath, ...argumentsList], {
      cwd: cliCwd,
      encoding: "utf8",
    });

  const filesBefore = await listStateFiles();
  const statusRun = runCli(["collaboration", "status", "--json"]);
  observations.collaborationStatusExitCode = statusRun.status;
  if (statusRun.status !== 0) {
    failures.push("collaboration status 退出码应为 0，实际 " + String(statusRun.status));
  } else {
    try {
      const parsed = JSON.parse(statusRun.stdout);
      if (parsed.status !== "ok") failures.push("collaboration status 未返回 status:ok");
      if (parsed.view?.isWritable !== false) failures.push("collaboration status 必须是只读（isWritable:false）");
      if (typeof parsed.notice !== "string" || !parsed.notice.includes("空 ≠")) {
        failures.push("空状态必须写「空 ≠ 不存在」，实际 notice=" + String(parsed.notice));
      }
    } catch (error) {
      failures.push("collaboration status 输出不是合法 JSON：" + String(error));
    }
  }

  const listRun = runCli(["inbox", "list", "--recipient", "agent-package-check", "--json"]);
  if (listRun.status !== 0) {
    failures.push("inbox list 退出码应为 0，实际 " + String(listRun.status));
  } else {
    try {
      const parsed = JSON.parse(listRun.stdout);
      if (parsed.isPresent !== false) failures.push("未保存过时 inbox list 必须 isPresent:false");
      if (typeof parsed.notice !== "string" || !parsed.notice.includes("空 ≠ 无消息")) {
        failures.push("inbox list 空状态必须写「空 ≠ 无消息」");
      }
    } catch (error) {
      failures.push("inbox list 输出不是合法 JSON：" + String(error));
    }
  }

  const deliverRun = runCli(["inbox", "deliver", "--recipient", "agent-package-check", "--json"]);
  if (deliverRun.status !== 2) {
    failures.push("inbox deliver 在无收件箱时退出码必须为 2，实际 " + String(deliverRun.status));
  }

  const filesAfter = await listStateFiles();
  if (JSON.stringify(filesBefore) !== JSON.stringify(filesAfter)) {
    failures.push("只读入口不得改动状态目录文件清单");
  }

} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`COMM 多实例离线闭环验收失败：${String(failures.length)} 项\n`);
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}
process.stdout.write("COMM 多实例离线闭环通过：独立进程 fork/IPC、崩溃后 replay 不丢、ack 后不重复、接收者隔离、优雅关闭\n");









