/**
 * RESUME-02（2026-11-24）：远程通道的 `/resume <任务编号>` 显式命令适配。
 *
 * 纪律（卡内原文）：
 * - **只有严格命令形态**才算续接请求：`/resume <单一任务标识>`，大小写敏感、无额外参数；
 * - 普通消息（含"继续""接着做"、引号里的继续、任务标题含继续）**一律不触发**；
 * - 主体必须由可信会话解析（本层不信任正文自报）；来源通道必须在允许集合内；
 * - 不做模糊匹配、不调用意图模型；解析失败给出明确原因码，不猜目标。
 */
import { createHash } from "node:crypto";

export type RemoteResumeCommandParse =
  | { readonly kind: "not-a-command" }
  | {
      readonly kind: "invalid";
      readonly reasonCode: "missing-target" | "too-many-arguments" | "invalid-target";
      readonly detail: string;
    }
  | {
      readonly kind: "denied";
      readonly reasonCode: "unauthenticated" | "channel-not-allowed";
      readonly detail: string;
    }
  | {
      readonly kind: "parsed";
      readonly taskIdentifier: string;
      /** 由（通道, 主体, 任务, 消息）确定性派生：重连重试复用同一幂等键。 */
      readonly requestIdentifier: string;
      readonly sourceChannel: string;
    };

const COMMAND_PREFIX = "/resume";
/** 任务标识：与任务链 id 允许的字符一致（字母数字 . _ -）。 */
const TASK_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export function parseRemoteResumeCommand(input: {
  readonly text: string;
  readonly sourceChannel: string;
  /** 可信会话解析出的主体；未认证为 null。 */
  readonly authenticatedPrincipalIdentifier: string | null;
  /** 允许触发续接的通道（缺省仅 "remote-im"）。 */
  readonly allowedSourceChannels?: readonly string[];
  /** 平台消息标识（用于幂等键；缺省为空则退化为任务+主体）。 */
  readonly platformMessageIdentifier?: string | null;
}): RemoteResumeCommandParse {
  const trimmedText = input.text.trim();
  if (!trimmedText.startsWith(COMMAND_PREFIX)) {
    return { kind: "not-a-command" };
  }
  if (input.authenticatedPrincipalIdentifier === null || input.authenticatedPrincipalIdentifier.trim() === "") {
    return {
      kind: "denied",
      reasonCode: "unauthenticated",
      detail: "续接命令必须来自已认证主体（不信任消息正文自报身份）。",
    };
  }
  const allowedChannels = input.allowedSourceChannels ?? ["remote-im"];
  if (!allowedChannels.includes(input.sourceChannel)) {
    return {
      kind: "denied",
      reasonCode: "channel-not-allowed",
      detail: `通道 ${input.sourceChannel} 不允许触发续接。`,
    };
  }
  const remainder = trimmedText.slice(COMMAND_PREFIX.length);
  /** `/resumex` 这类前缀不算命令（避免误吞普通文本）。 */
  if (remainder !== "" && !/^\s/u.test(remainder)) {
    return { kind: "not-a-command" };
  }
  const argumentsList = remainder.trim() === "" ? [] : remainder.trim().split(/\s+/u);
  if (argumentsList.length === 0) {
    return {
      kind: "invalid",
      reasonCode: "missing-target",
      detail: "命令缺少任务标识：/resume <任务编号>",
    };
  }
  if (argumentsList.length > 1) {
    return {
      kind: "invalid",
      reasonCode: "too-many-arguments",
      detail: "命令只接受一个任务标识（不猜测额外参数含义）。",
    };
  }
  const taskIdentifier = argumentsList[0]!;
  if (!TASK_IDENTIFIER_PATTERN.test(taskIdentifier)) {
    return {
      kind: "invalid",
      reasonCode: "invalid-target",
      detail: "任务标识只允许字母、数字、点、下划线与连字符。",
    };
  }
  const requestIdentifier =
    "remote-resume:" +
    createHash("sha256")
      .update(
        `${input.sourceChannel}|${input.authenticatedPrincipalIdentifier}|${taskIdentifier}|${input.platformMessageIdentifier ?? ""}`,
      )
      .digest("hex")
      .slice(0, 32);
  return {
    kind: "parsed",
    taskIdentifier,
    requestIdentifier,
    sourceChannel: input.sourceChannel,
  };
}
