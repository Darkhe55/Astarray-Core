/**
 * RESUME-02（2026-11-24，检查点 05 最小公共接线）：断点续接的**只读状态**命令。
 *
 * 只做诊断：读取配置（缺省关闭）、有效回执数、活动领取清单；
 * **不**派发、不恢复、不接受自然语言，也不把"存在领取"写成"已恢复"。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { ContinuationController } from "../../../core/src/orchestration/continuation-controller.js";
import { ResumeIntentReceiptStore } from "../../../core/src/orchestration/continuation-receipt-store.js";
import { resolveCheckpointContinuationSetting } from "../../../core/src/orchestration/continuation-request.js";

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
  const controller = new ContinuationController({
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
