/**
 * SECRETARY-01-04 公开入口（2026-10-23）：`astarray secretary status`。
 *
 * 卡内要求：公开包入口、预算/工作时段有效、启动不阻塞项目对话、证据可追溯。
 * 用户口径（2026-10-22）：**预算默认不限、工作时段默认全天**。
 *
 * 本命令只读：打印默认值、启动决策、预算判定与工作时段判定；不写任何配置。
 */
import {
  DEFAULT_SECRETARY_BUDGET,
  DEFAULT_SECRETARY_WORK_WINDOW,
  SECRETARY_HABITS,
  describeSecretaryDefaultsForConfirmation,
  evaluateSecretaryBudget,
  evaluateSecretaryStartup,
  evaluateSecretaryWorkWindow,
  type SecretaryHabit,
} from "../../../core/src/orchestration/secretary-policy.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

export interface SecretaryStatusCommandOptions {
  stateDirectory: string;
  tokensUsed: number;
  sessionTokenLimit: number | undefined;
  minuteOfDay: number;
  startMinuteOfDay: number | undefined;
  endMinuteOfDay: number | undefined;
  isProjectConversationBusy: boolean;
  habit: string | undefined;
  isJsonOutput: boolean;
}

/** `secretary status`：只读展示秘书默认值与当前判定。 */
export async function executeSecretaryStatusCommand(
  options: SecretaryStatusCommandOptions,
): Promise<number> {
  const habit: SecretaryHabit = options.habit === undefined ? "project-first" : (options.habit as SecretaryHabit);
  if (!(SECRETARY_HABITS as ReadonlyArray<string>).includes(habit)) {
    logToStderr(
      "--habit 必须是 " + SECRETARY_HABITS.join(" | ") + " 之一（收到: " + String(options.habit) + "）",
    );
    return EXIT_CODES.FAILURE;
  }
  if (!Number.isFinite(options.tokensUsed) || options.tokensUsed < 0) {
    logToStderr("--tokens-used 必须是非负数（收到: " + String(options.tokensUsed) + "）");
    return EXIT_CODES.FAILURE;
  }
  if (!Number.isFinite(options.minuteOfDay) || options.minuteOfDay < 0 || options.minuteOfDay > 1440) {
    logToStderr("--minute-of-day 必须在 0–1440 之间（收到: " + String(options.minuteOfDay) + "）");
    return EXIT_CODES.FAILURE;
  }

  const startup = evaluateSecretaryStartup({ habit, isProjectConversationBusy: options.isProjectConversationBusy });
  const budget = evaluateSecretaryBudget({
    tokensUsed: options.tokensUsed,
    ...(options.sessionTokenLimit === undefined ? {} : { sessionTokenLimit: options.sessionTokenLimit }),
  });
  const workWindow = evaluateSecretaryWorkWindow({
    minuteOfDay: options.minuteOfDay,
    ...(options.startMinuteOfDay === undefined ? {} : { startMinuteOfDay: options.startMinuteOfDay }),
    ...(options.endMinuteOfDay === undefined ? {} : { endMinuteOfDay: options.endMinuteOfDay }),
  });

  const report = {
    status: "ok" as const,
    habit,
    defaults: describeSecretaryDefaultsForConfirmation(),
    effectiveDefaults: {
      sessionTokenLimit: DEFAULT_SECRETARY_BUDGET.sessionTokenLimit,
      startMinuteOfDay: DEFAULT_SECRETARY_WORK_WINDOW.startMinuteOfDay,
      endMinuteOfDay: DEFAULT_SECRETARY_WORK_WINDOW.endMinuteOfDay,
    },
    startup,
    budget,
    workWindow,
  };

  if (options.isJsonOutput) {
    printJson(report);
    return EXIT_CODES.SUCCESS;
  }
  process.stdout.write(
    [
      "habit=" + habit,
      "startup=" + startup.kind,
      "budget=" + budget.kind,
      "workWindow=" + workWindow.kind,
      ...report.defaults.map((line) => "- " + line),
      startup.kind === "deferred" ? "- " + startup.reason : "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );
  return EXIT_CODES.SUCCESS;
}
