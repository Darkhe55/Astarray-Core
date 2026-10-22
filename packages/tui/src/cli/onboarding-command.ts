/**
 * ONBOARD-01-02 公开入口（2026-10-23）：`astarray onboarding status`。
 *
 * 卡内要求：首次/适时提示触发、冷却、拒绝状态（跳过/不再提示/重启与迁移不反复弹）、
 * 项目/秘书界面入口、**不抢焦点**、**不隐式授权**、显式执行需用户确认。
 *
 * 本命令只读：读取本地提示状态（缺失即视为首次），打印判定与两个界面入口的可用性；不写状态。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS,
  FIRST_ONBOARDING_HINT_TEXT,
  createOnboardingHintState,
  describeOnboardingMetadataBoundary,
  evaluateOnboardingHint,
  type OnboardingHintContext,
  type OnboardingHintStateV1,
} from "../../../core/src/orchestration/onboarding-hint-contract.js";
// 界面入口规则在 secretary-policy（ONBOARD-01-02 的入口部分）
import {
  ONBOARDING_SURFACES,
  evaluateOnboardingEntry,
  type OnboardingSurface,
} from "../../../core/src/orchestration/secretary-policy.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

export interface OnboardingStatusCommandOptions {
  stateDirectory: string;
  nowIso: string | undefined;
  isUserTyping: boolean;
  isAuthorizationPending: boolean;
  isErrorRecovery: boolean;
  isEmergencyActive: boolean;
  isHighLoad: boolean;
  hasCompletedMilestone: boolean;
  hasAskedAboutEfficiency: boolean;
  hasDuplicateWorkDetected: boolean;
  isStateUnknownAfterMigration: boolean;
  isJsonOutput: boolean;
}

function hintStateFilePath(stateDirectory: string): string {
  return path.join(stateDirectory, "onboarding", "hint-state.json");
}

/** 读取本地提示状态；缺失 ⇒ 首次状态；损坏 ⇒ 抛出（由命令 fail-closed）。 */
function readHintState(stateDirectory: string): OnboardingHintStateV1 {
  const filePath = hintStateFilePath(stateDirectory);
  if (!existsSync(filePath)) {
    return createOnboardingHintState();
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<OnboardingHintStateV1>;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.hasSeenFirstHint !== "boolean" ||
    typeof parsed.isNeverShowAgain !== "boolean" ||
    typeof parsed.shownCount !== "number"
  ) {
    throw new Error("本地提示状态结构不合法");
  }
  return {
    schemaVersion: 1,
    hasSeenFirstHint: parsed.hasSeenFirstHint,
    isNeverShowAgain: parsed.isNeverShowAgain,
    lastShownAtIso: parsed.lastShownAtIso ?? null,
    shownCount: parsed.shownCount,
  };
}

/** `onboarding status`：只读展示提示判定与入口可用性。 */
export async function executeOnboardingStatusCommand(
  options: OnboardingStatusCommandOptions,
): Promise<number> {
  let state: OnboardingHintStateV1;
  try {
    state = readHintState(options.stateDirectory);
  } catch (error) {
    logToStderr(
      "无法读取本地提示状态：" + (error instanceof Error ? error.message : String(error)) + "（fail-closed）",
    );
    return EXIT_CODES.FAILURE;
  }

  const context: OnboardingHintContext = {
    isUserTyping: options.isUserTyping,
    isAuthorizationPending: options.isAuthorizationPending,
    isErrorRecovery: options.isErrorRecovery,
    isEmergencyActive: options.isEmergencyActive,
    isHighLoad: options.isHighLoad,
  };
  const decision = evaluateOnboardingHint({
    nowIso: options.nowIso ?? new Date().toISOString(),
    state,
    context,
    triggerSignals: {
      hasCompletedMilestone: options.hasCompletedMilestone,
      hasAskedAboutEfficiency: options.hasAskedAboutEfficiency,
      hasDuplicateWorkDetected: options.hasDuplicateWorkDetected,
    },
    isStateUnknownAfterMigration: options.isStateUnknownAfterMigration,
  });

  const isBusy =
    options.isUserTyping ||
    options.isAuthorizationPending ||
    options.isErrorRecovery ||
    options.isEmergencyActive ||
    options.isHighLoad;
  const entries = ONBOARDING_SURFACES.map((surface: OnboardingSurface) =>
    evaluateOnboardingEntry({ surface, isBusy }),
  );

  const report = {
    status: "ok" as const,
    decision,
    entries,
    surfaces: [...ONBOARDING_SURFACES],
    defaults: {
      minimumIntervalDays: DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS,
      firstHintText: FIRST_ONBOARDING_HINT_TEXT,
    },
    metadataBoundary: describeOnboardingMetadataBoundary(),
  };

  if (options.isJsonOutput) {
    printJson(report);
    return EXIT_CODES.SUCCESS;
  }
  process.stdout.write(
    [
      "decision=" + decision.kind,
      decision.kind === "suppress" ? "reason=" + decision.reasonCode : "reason=" + decision.reason,
      "entries=" + entries.map((entry) => entry.kind).join(","),
      "- 冷却 " + String(DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS) + " 天；不抢焦点、不隐式授权",
    ].join("\n") + "\n",
  );
  return EXIT_CODES.SUCCESS;
}

