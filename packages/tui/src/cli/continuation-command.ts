/**
 * RESUME-02（2026-11-24，检查点 05 最小公共接线）：断点续接的**只读状态**命令。
 *
 * 只做诊断：读取配置（缺省关闭）、有效回执数、活动领取清单；
 * **不**派发、不恢复、不接受自然语言，也不把"存在领取"写成"已恢复"。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { CheckpointContinuationController } from "../../../core/src/orchestration/continuation-controller.js";
import { ResumeIntentReceiptStore } from "../../../core/src/orchestration/continuation-receipt-store.js";
import {
  evaluateContinuationRequest,
  resolveCheckpointContinuationSetting,
  type ContinuationCandidate,
  type ContinuationTaskState,
  type StructuredContinuationRequest,
} from "../../../core/src/orchestration/continuation-request.js";
import { TaskStore } from "../../../core/src/infra/task-store.js";
import { logToStderr } from "./json-output.js";

export interface ContinuationStatusCommandOptions {
  readonly stateDirectory: string;
  readonly nowIso?: string;
  readonly isJsonOutput: boolean;
}

export const CONTINUATION_CONFIG_FILE_NAME = "continuation/config.json";

/** 配置缺失/损坏/非 true ⇒ 关闭（与判定层同一语义）。 */
export async function readCheckpointContinuationSetting(
  stateDirectory: string,
): Promise<ReturnType<typeof resolveCheckpointContinuationSetting>> {
  const filePath = path.join(stateDirectory, CONTINUATION_CONFIG_FILE_NAME);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return resolveCheckpointContinuationSetting({ configuredValue: undefined });
  }
  try {
    const parsed = JSON.parse(content) as { isCheckpointContinuationEnabled?: unknown };
    return resolveCheckpointContinuationSetting({
      configuredValue: parsed.isCheckpointContinuationEnabled,
    });
  } catch {
    return resolveCheckpointContinuationSetting({ configuredValue: "corrupt" });
  }
}

export async function executeContinuationStatusCommand(
  options: ContinuationStatusCommandOptions,
): Promise<number> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const setting = await readCheckpointContinuationSetting(options.stateDirectory);
  const receiptStore = new ResumeIntentReceiptStore({ baseDirectory: options.stateDirectory });
  const controller = new CheckpointContinuationController({
    baseDirectory: options.stateDirectory,
    receiptStore,
    setting,
  });
  const activeReceiptCount = await receiptStore.count(nowIso);
  const activeClaims = await controller.listClaims(nowIso);
  const status = {
    status: "continuation-status",
    isEnabled: setting.isEnabled,
    settingReason: setting.reason,
    activeReceiptCount,
    activeClaims: activeClaims.map((claim) => ({
      claimIdentifier: claim.claimIdentifier,
      projectIdentifier: claim.projectIdentifier,
      taskIdentifier: claim.taskIdentifier,
      expectedRevision: claim.expectedRevision,
      fencingToken: claim.fencingToken,
      expiresAtIso: claim.expiresAtIso,
    })),
    note: "只读状态：领取不等于已恢复/已派发。",
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(
      `断点续接: ${setting.isEnabled ? "已启用" : `关闭（${setting.reason}）`}\n` +
        `有效回执: ${String(activeReceiptCount)}\n` +
        `活动领取: ${String(activeClaims.length)}\n`,
    );
  }
  return 0;
}

/** 任务链状态 → 续接状态（本地权威记录，不信任请求正文自报）。 */
function mapTaskStatusToContinuationState(status: string): ContinuationTaskState {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "completed";
    case "pending":
      return "planned";
    /** blocked/failed：原因各异，统一按"需对账"处理，不猜成答案或授权。 */
    default:
      return "started-unknown";
  }
}

export interface ContinuationRequestCommandOptions {
  readonly stateDirectory: string;
  /** 可信会话解析出的认证主体；缺省读取宿主注入的环境变量。 */
  readonly principalIdentifier: string | null;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly expectedRevision: number;
  readonly requestIdentifier: string | null;
  readonly nowIso?: string;
  readonly isJsonOutput: boolean;
}

/**
 * 显式续接请求（写路径）：读配置 → 读本地任务链 → 状态推导 → 登记回执 → 领取。
 * **不派发**；领取成功也只表示"可派发"。
 */
export async function executeContinuationRequestCommand(
  options: ContinuationRequestCommandOptions,
): Promise<number> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const setting = await readCheckpointContinuationSetting(options.stateDirectory);
  if (!setting.isEnabled) {
    process.stdout.write(JSON.stringify({ status: "disabled", settingReason: setting.reason }) + "\n");
    return 0;
  }
  const principalIdentifier =
    options.principalIdentifier ?? process.env["ASTARRAY_AUTHENTICATED_USER_ID"] ?? null;
  if (principalIdentifier === null || principalIdentifier === "") {
    logToStderr("未认证：续接请求需要可信会话解析出的主体（不信任请求正文自报）。");
    return 2;
  }
  const taskStore = new TaskStore({ baseDirectory: options.stateDirectory });
  const chain = await taskStore.readTaskChain(options.missionIdentifier).catch(() => null);
  if (chain === null) {
    process.stdout.write(JSON.stringify({ status: "nothing-to-resume", reasonCode: "mission-not-found" }) + "\n");
    return 0;
  }
  const candidates: ContinuationCandidate[] = chain.tasks.map((task) => ({
    taskIdentifier: task.id,
    projectIdentifier: options.missionIdentifier,
    taskState: mapTaskStatusToContinuationState(task.status),
    revision: chain.revision,
  }));
  const requestIdentifier = options.requestIdentifier ?? "req-" + randomUUID();
  const structuredRequest: StructuredContinuationRequest = {
    requestIdentifier,
    projectIdentifier: options.missionIdentifier,
    conversationIdentifier: null,
    taskIdentifier: options.taskIdentifier,
    expectedRevision: options.expectedRevision,
  };
  const evaluation = evaluateContinuationRequest({
    setting,
    request: structuredRequest,
    candidates,
  });
  if (evaluation.status !== "resumable") {
    process.stdout.write(JSON.stringify(evaluation) + "\n");
    return 0;
  }
  const receiptStore = new ResumeIntentReceiptStore({ baseDirectory: options.stateDirectory });
  const receipt = await receiptStore.issue({
    receiptIdentifier: "receipt-" + requestIdentifier,
    request: structuredRequest,
    principalIdentifier,
    sourceChannel: "cli",
    nowIso,
  });
  const controller = new CheckpointContinuationController({ baseDirectory: options.stateDirectory, receiptStore, setting });
  const result = await controller.requestContinuation({
    request: structuredRequest,
    candidates,
    principalIdentifier,
    requestIdentifier: receipt.receipt.requestIdentifier,
    nowIso,
  });
  process.stdout.write(
    JSON.stringify({ ...result, note: "领取成功≠已派发：assemble/dispatch 尚未接线。" }) + "\n",
  );
  return 0;
}
