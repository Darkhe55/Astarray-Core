/**
 * RESUME-02（2026-11-24）：远程 `/resume <任务>` 的**投递接线**。
 *
 * 目标：把"解析出来的命令"接到**产品路径**（断点驱动）上，而不是再发明一套判定：
 *
 *   /resume T-1
 *     → parseRemoteResumeCommand（严格命令形态、主体/通道校验、确定性幂等键）
 *     → 按 mission 找**可恢复的断点**（只找当前 open 且 canResume 的卡片）
 *     → ContinuationController.requestContinuation（幂等键 + 版本复核 + 恢复门禁）
 *
 * 纪律：
 * - 普通文本**不触发**任何查询或派发（连断点都不读）；
 * - 解析失败/未认证/通道不允许 ⇒ 明确拒绝，**不**猜目标、**不**调用请求；
 * - 找不到可恢复断点 ⇒ `not-found`/`not-resumable`（不凭空造一张卡）；
 * - 重复投递复用同一幂等键 ⇒ 由 controller 判 `already-requested`；
 * - `resumed` 只表示"恢复已派发"，**不**表示任务完成。
 */
import {
  parseRemoteResumeCommand,
  type RemoteResumeCommandParse,
} from "./remote-resume-command.js";
import type {
  ContinuationBreakpointView,
  ContinuationRequestResult,
} from "./continuation-breakpoint.js";

/** 宿主注入的端口：读断点 + 发起请求（通常直接接门面方法）。 */
export interface RemoteResumeDispatchPorts {
  /** 找该 mission 当前可用于续接的断点（没有则 null；实现方不得编造）。 */
  readonly findOpenBreakpoint: (input: {
    readonly missionIdentifier: string;
  }) => Promise<ContinuationBreakpointView | null>;
  /** 走产品路径发起续接（门面 `requestContinuation`）。 */
  readonly requestContinuation: (input: {
    readonly breakpointIdentifier: string;
    readonly missionIdentifier: string;
    readonly expectedRevision: number;
    readonly requestIdentifier: string;
  }) => Promise<ContinuationRequestResult>;
}

export type RemoteResumeDispatchResult =
  | { readonly kind: "ignored"; readonly reason: string }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "unauthenticated"
        | "channel-not-allowed"
        | "missing-target"
        | "too-many-arguments"
        | "invalid-target";
      readonly detail: string;
    }
  | {
      readonly kind: "no-breakpoint";
      readonly missionIdentifier: string;
      readonly detail: string;
    }
  | {
      readonly kind: "not-resumable";
      readonly missionIdentifier: string;
      readonly breakpointIdentifier: string;
      readonly detail: string;
    }
  | {
      readonly kind: "requested";
      readonly missionIdentifier: string;
      readonly breakpointIdentifier: string;
      readonly requestIdentifier: string;
      readonly outcome: ContinuationRequestResult["outcome"];
      readonly reason: string;
    };

function toRejection(parsed: RemoteResumeCommandParse): RemoteResumeDispatchResult | null {
  if (parsed.kind === "denied") {
    return { kind: "rejected", reasonCode: parsed.reasonCode, detail: parsed.detail };
  }
  if (parsed.kind === "invalid") {
    return { kind: "rejected", reasonCode: parsed.reasonCode, detail: parsed.detail };
  }
  return null;
}

export async function dispatchRemoteResume(input: {
  readonly text: string;
  readonly sourceChannel: string;
  readonly authenticatedPrincipalIdentifier: string | null;
  readonly allowedSourceChannels?: readonly string[];
  readonly platformMessageIdentifier?: string | null;
  readonly ports: RemoteResumeDispatchPorts;
}): Promise<RemoteResumeDispatchResult> {
  const parsed = parseRemoteResumeCommand({
    text: input.text,
    sourceChannel: input.sourceChannel,
    authenticatedPrincipalIdentifier: input.authenticatedPrincipalIdentifier,
    ...(input.allowedSourceChannels === undefined
      ? {}
      : { allowedSourceChannels: input.allowedSourceChannels }),
    ...(input.platformMessageIdentifier === undefined
      ? {}
      : { platformMessageIdentifier: input.platformMessageIdentifier }),
  });

  if (parsed.kind === "not-a-command") {
    return {
      kind: "ignored",
      reason: "不是 /resume 命令（普通消息不触发续接，也不读取断点）。",
    };
  }
  const rejection = toRejection(parsed);
  if (rejection !== null) return rejection;

  /** 到这里 parsed 必为 parsed 分支；TS 收窄需要显式判空。 */
  if (parsed.kind !== "parsed") {
    return { kind: "ignored", reason: "解析结果异常（防御性拒绝）。" };
  }

  const breakpoint = await input.ports.findOpenBreakpoint({
    missionIdentifier: parsed.taskIdentifier,
  });
  if (breakpoint === null) {
    return {
      kind: "no-breakpoint",
      missionIdentifier: parsed.taskIdentifier,
      detail: "该任务没有可续接的断点（未中断/已归档/从未运行）。",
    };
  }
  if (!breakpoint.canResume) {
    return {
      kind: "not-resumable",
      missionIdentifier: parsed.taskIdentifier,
      breakpointIdentifier: breakpoint.breakpointIdentifier,
      detail: breakpoint.blockedReason ?? "当前状态不可续接。",
    };
  }

  const result = await input.ports.requestContinuation({
    breakpointIdentifier: breakpoint.breakpointIdentifier,
    missionIdentifier: parsed.taskIdentifier,
    expectedRevision: breakpoint.revision,
    requestIdentifier: parsed.requestIdentifier,
  });
  return {
    kind: "requested",
    missionIdentifier: parsed.taskIdentifier,
    breakpointIdentifier: breakpoint.breakpointIdentifier,
    requestIdentifier: parsed.requestIdentifier,
    outcome: result.outcome,
    reason: result.reason,
  };
}
