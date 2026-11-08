/**
 * ALIGN-02-05 跨进程**序列领取**夹具：在独立进程里跑真实构建产物的
 * `TaskSequenceManageController`，对同一序列执行 claim / release / status。
 *
 * 为什么需要它：租约隔离已验证，但"B 接管租约后能否真的 claim 同一序列任务"
 * 仍然只靠单进程模拟。这里让两个进程共享同一份磁盘序列，直接观察结果。
 *
 * 用法：node sequence-claim-child-fixture.mjs <stateDirectory> <owner> <taskId> <claim|release|status> [processInstanceId]
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const [stateDirectory, owner, taskId, action, processInstanceId] =
  process.argv.slice(2);
if (
  typeof stateDirectory !== "string" ||
  typeof owner !== "string" ||
  typeof taskId !== "string" ||
  typeof action !== "string"
) {
  stdout.write(`${JSON.stringify({ error: "bad-arguments" })}\n`);
  process.exit(2);
}

function resolveBuiltModule(prefix) {
  const moduleDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "dist",
  );
  const candidates = readdirSync(moduleDirectory).filter(
    (fileName) => fileName.startsWith(prefix) && fileName.endsWith(".js"),
  );
  if (candidates.length === 0) {
    throw new Error(`构建产物缺少模块: ${prefix}（请先 npm run build）`);
  }
  return path.join(moduleDirectory, candidates[0]);
}

const storeModule = await import(
  pathToFileURL(resolveBuiltModule("agent-task-sequence-store-")).href
);
const controllerModule = await import(
  pathToFileURL(resolveBuiltModule("task-sequence-controllers-")).href
);

const store = new storeModule.AgentTaskSequenceStore({
  baseDirectory: stateDirectory,
});
const manage = new controllerModule.TaskSequenceManageController(store);
const status = new controllerModule.TaskSequenceStatusController(store);
const sequenceId = `sequence-${owner}`;
const viewer = { sourceKind: "user", actorId: "user-1" };

if (action === "claim") {
  const claimed = await manage.claimTask({
    ownerAgentInstanceId: owner,
    sequenceId,
    taskId,
  });
  stdout.write(
    `${JSON.stringify({ claimed, processInstanceId: processInstanceId ?? null })}\n`,
  );
} else if (action === "release") {
  const released = await manage.releaseClaim({
    ownerAgentInstanceId: owner,
    sequenceId,
    taskId,
  });
  stdout.write(`${JSON.stringify({ released })}\n`);
} else if (action === "status") {
  const snapshot = await status.getSnapshot({
    ownerAgentInstanceId: owner,
    sequenceId,
    viewer,
  });
  const node = snapshot.nodes.find((candidate) => candidate.taskId === taskId);
  stdout.write(
    `${JSON.stringify({ status: node?.status ?? null, revision: snapshot.revision })}\n`,
  );
} else {
  stdout.write(`${JSON.stringify({ error: "unknown-action" })}\n`);
  process.exit(2);
}
