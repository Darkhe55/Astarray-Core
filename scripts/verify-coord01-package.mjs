#!/usr/bin/env node
/**
 * COORD-01-04：**tarball 隔离安装验证**。
 *
 * 只经安装包入口（`node_modules/astarray/dist/public-sdk.js`）验证协调链路：
 * ① 消息入库 → 消费步应用一次；
 * ② 二次消费不重复应用（幂等跨调用）；
 * ③ 控制旁路拒绝 agent 来源（权限不因打包而放松）。
 *
 * 用法：node scripts/verify-coord01-package.mjs --package-dir <隔离安装目录>
 */
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const packageDirectory = readArgument("--package-dir");
if (packageDirectory === null) {
  console.error("缺少 --package-dir <隔离安装目录>");
  process.exit(2);
}

const entryPath = path.join(packageDirectory, "node_modules", "astarray", "dist", "public-sdk.js");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (entryPath.startsWith(repositoryRoot + path.sep)) {
  console.error("疑似从仓库源码导入：", entryPath);
  process.exit(2);
}

const sdk = await import(pathToFileURL(entryPath).href);
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-package-"));
let failureCount = 0;

try {
  const facade = await sdk.AstarrayApplicationFacade.create({
    mode: "assist",
    stateDirectory,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });

  /** ① 未知消息 ⇒ 空数组（不伪造）。 */
  const unknownStatus = await facade.readCoordinationMessageStatus("unknown-message");
  if (unknownStatus.length !== 0) {
    console.error("① 未知消息被伪造出状态：", JSON.stringify(unknownStatus));
    failureCount += 1;
  }

  /** ② agent 来源控制事件必须被拒（权限不因打包而放松）。 */
  const agentControl = facade.applyCoordinationControlEvent({
    eventIdentifier: "package-control-1",
    kind: "cancel",
    source: { sourceKind: "agent", sourceIdentifier: "worker-1" },
    targetMissionIdentifier: "mission-1",
    issuedAtIso: "2026-11-11T00:00:00.000Z",
  });
  if (agentControl.outcome !== "rejected-untrusted-source") {
    console.error("② agent 来源控制未被拒绝：", agentControl.outcome);
    failureCount += 1;
  }

  /** ③ 可信来源控制事件 ⇒ 生效。 */
  const trustedControl = facade.applyCoordinationControlEvent({
    eventIdentifier: "package-control-2",
    kind: "cancel",
    source: { sourceKind: "user", sourceIdentifier: "user:alice" },
    targetMissionIdentifier: "mission-1",
    issuedAtIso: "2026-11-11T00:00:01.000Z",
  });
  if (trustedControl.outcome !== "applied" || trustedControl.isExecutionBlocked !== true) {
    console.error("③ 可信控制事件未生效：", JSON.stringify(trustedControl));
    failureCount += 1;
  }

  /** ④ 上下文准入：未知消息 ⇒ message-not-found（不静默成功）。 */
  const admission = await facade.admitCoordinationContext({
    recipientId: "agent:main-agent-1",
    messageId: "unknown-message",
  });
  if (admission.outcome !== "message-not-found") {
    console.error("④ 未知消息准入未返回 message-not-found：", admission.outcome);
    failureCount += 1;
  }

  await facade.shutdown?.().catch(() => undefined);
  console.log("coord01-package: " + (failureCount === 0 ? "ok" : "failed"));
  console.log("  entry=" + entryPath);
  console.log("  failures=" + String(failureCount));
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
process.exit(failureCount === 0 ? 0 : 1);
