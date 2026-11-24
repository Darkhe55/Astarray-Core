/**
 * RESUME-02（2026-11-24）：**产品路径**（断点驱动）的 CLI 入口。
 *
 * 只做两件事，全部经公共门面：
 * - `continuation breakpoints --conversation <id>`：列出该会话当前断点卡（只读；不恢复）；
 * - `continuation resume --breakpoint <id> --mission <id> --revision <n> --request <id>`：
 *   显式请求续接（幂等键 + 版本复核 + 既有恢复门禁）。
 *
 * 纪律：resumed 只表示"恢复已派发"，**不**宣称任务完成；被门禁拒绝时如实返回 blocked。
 */
import { AstarrayApplicationFacade } from "../../../core/src/public-sdk.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

export interface ContinuationBreakpointsCommandOptions {
  readonly stateDirectory: string;
  readonly conversationIdentifier: string;
  readonly isJsonOutput: boolean;
}

export interface ContinuationResumeCommandOptions {
  readonly stateDirectory: string;
  readonly breakpointIdentifier: string;
  readonly missionIdentifier: string;
  readonly expectedRevision: number;
  readonly requestIdentifier: string;
  readonly isJsonOutput: boolean;
}

async function withFacade<T>(
  stateDirectory: string,
  action: (facade: AstarrayApplicationFacade) => Promise<T>,
): Promise<T> {
  const facade = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
  });
  try {
    return await action(facade);
  } finally {
    await facade.shutdown().catch(() => undefined);
  }
}

export async function executeContinuationBreakpointsCommand(
  options: ContinuationBreakpointsCommandOptions,
): Promise<number> {
  const views = await withFacade(options.stateDirectory, (facade) =>
    facade.queryContinuationBreakpoints(options.conversationIdentifier),
  );
  if (options.isJsonOutput) {
    printJson(views);
  } else if (views.length === 0) {
    process.stdout.write("没有断点记录（该会话没有可续接的中断）。\n");
  } else {
    for (const view of views) {
      process.stdout.write(
        `${view.breakpointIdentifier} status=${view.status} revision=${String(view.revision)} ` +
          `task=${view.taskShortName}\n  下一步：${view.nextStep}\n`,
      );
    }
  }
  return EXIT_CODES.SUCCESS;
}

export async function executeContinuationResumeCommand(
  options: ContinuationResumeCommandOptions,
): Promise<number> {
  if (options.requestIdentifier.trim() === "") {
    logToStderr("续接请求必须带幂等键（--request）");
    return EXIT_CODES.USAGE_ERROR;
  }
  if (!Number.isInteger(options.expectedRevision) || options.expectedRevision < 0) {
    logToStderr("--revision 必须是非负整数");
    return EXIT_CODES.USAGE_ERROR;
  }
  const result = await withFacade(options.stateDirectory, (facade) =>
    facade.requestContinuation({
      breakpointIdentifier: options.breakpointIdentifier,
      missionIdentifier: options.missionIdentifier,
      expectedRevision: options.expectedRevision,
      requestIdentifier: options.requestIdentifier,
    }),
  );
  if (options.isJsonOutput) {
    printJson(result);
  } else {
    process.stdout.write(
      `续接结果：${result.outcome}\n${result.reason === null ? "" : `原因：${result.reason}\n`}`,
    );
  }
  return result.outcome === "resumed" ? EXIT_CODES.SUCCESS : EXIT_CODES.SUCCESS;
}
