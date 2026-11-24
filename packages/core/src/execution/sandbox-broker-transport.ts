/**
 * E3-2（2026-11-25）：沙箱 broker 的**传输层契约**（纯判定，可离线验证）。
 *
 * 真正的命名管道/服务实现由后续 Rust/宿主组件完成；这里先把"管道怎么命名、谁能连、
 * 帧怎么切、出错怎么拒"钉死，避免实现阶段自由发挥。
 *
 * 安全约束：
 * - 管道名**按用户派生**：同一台机器上不同用户的 broker 互不串用；
 *   名字里只放 SID 的哈希（不暴露原始 SID）；
 * - **远程连接一律拒绝**（命名管道默认不允许远程，但仍要显式判定，防止配置漂移）；
 * - 连接方 SID 必须等于 broker 绑定用户（身份来自管道对端，不信任请求体）；
 * - 帧有硬上限（默认 64 KiB），超限/非法 JSON/缺字段/尾随垃圾一律拒绝；
 * - 管道不存在/未就绪 ⇒ 调用方 **fail-closed**（不得回退宿主直跑）。
 */
import { createHash } from "node:crypto";

export const DEFAULT_MAXIMUM_FRAME_BYTES = 64 * 1024;

/** 由用户 SID 派生稳定的管道名（不含原始 SID）。 */
export function buildBrokerPipeName(userSid: string): string {
  const trimmed = userSid.trim();
  if (trimmed === "") {
    throw new Error("buildBrokerPipeName: userSid 不能为空");
  }
  const digest = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\astarray-sandbox-broker-${digest}`;
}

export type BrokerConnectionDecision =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "rejected";
      readonly reasonCode: "remote-connection" | "caller-sid-mismatch" | "unauthenticated";
      readonly detail: string;
    };

export function evaluateBrokerConnection(input: {
  /** 管道对端解析出的已认证 SID；无法识别时为 null。 */
  readonly authenticatedClientSid: string | null;
  readonly brokerBoundUserSid: string;
  readonly isRemoteConnection: boolean;
}): BrokerConnectionDecision {
  if (input.isRemoteConnection) {
    return {
      kind: "rejected",
      reasonCode: "remote-connection",
      detail: "拒绝远程管道连接：broker 只服务本机会话。",
    };
  }
  if (input.authenticatedClientSid === null || input.authenticatedClientSid.trim() === "") {
    return {
      kind: "rejected",
      reasonCode: "unauthenticated",
      detail: "无法识别连接方 SID：拒绝。",
    };
  }
  if (input.authenticatedClientSid !== input.brokerBoundUserSid) {
    return { kind: "rejected", reasonCode: "caller-sid-mismatch", detail: "连接方 SID 与绑定用户不一致。" };
  }
  return { kind: "accepted" };
}

export interface BrokerMessageEnvelope {
  readonly schemaVersion: 1;
  readonly requestIdentifier: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type BrokerFrameParseResult =
  | { readonly kind: "frame"; readonly envelope: BrokerMessageEnvelope }
  | { readonly kind: "rejected"; readonly reasonCode: "frame-too-large" | "invalid-json" | "invalid-envelope"; readonly detail: string };

/**
 * 解析一帧（**不含**结尾换行；调用方负责按换行切帧与累积缓冲）。
 *
 * 规则：
 * - 超过上限 ⇒ `frame-too-large`（不尝试解析）；
 * - 非 JSON / 非对象 / 缺 `requestIdentifier` / schemaVersion 不为 1 ⇒ `invalid-envelope`。
 */
export function parseBrokerFrame(
  frameText: string,
  options: { readonly maximumFrameBytes?: number } = {},
): BrokerFrameParseResult {
  const maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_FRAME_BYTES;
  if (Buffer.byteLength(frameText, "utf8") > maximumFrameBytes) {
    return {
      kind: "rejected",
      reasonCode: "frame-too-large",
      detail: `帧超过上限（${String(maximumFrameBytes)} 字节）。`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    return { kind: "rejected", reasonCode: "invalid-json", detail: "帧不是合法 JSON。" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "rejected", reasonCode: "invalid-envelope", detail: "帧必须是 JSON 对象。" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate["schemaVersion"] !== 1) {
    return { kind: "rejected", reasonCode: "invalid-envelope", detail: "schemaVersion 必须为 1。" };
  }
  const requestIdentifier = candidate["requestIdentifier"];
  if (typeof requestIdentifier !== "string" || requestIdentifier.trim() === "") {
    return { kind: "rejected", reasonCode: "invalid-envelope", detail: "缺少 requestIdentifier。" };
  }
  const payload = candidate["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "rejected", reasonCode: "invalid-envelope", detail: "payload 必须是 JSON 对象。" };
  }
  return {
    kind: "frame",
    envelope: {
      schemaVersion: 1,
      requestIdentifier,
      payload: payload as Record<string, unknown>,
    },
  };
}

export function encodeBrokerFrame(envelope: BrokerMessageEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export type BrokerAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reasonCode: "pipe-not-found" | "connect-failed"; readonly detail: string };

/**
 * 调用方在**发起请求前**判定 broker 是否可用。
 *
 * 不可用 ⇒ 结果只能用于"拒绝执行"；**不得**回退宿主直跑（fail-closed）。
 */
export function evaluateBrokerAvailability(input: {
  readonly isPipePresent: boolean;
  readonly connectErrorCode?: string | null;
}): BrokerAvailability {
  if (!input.isPipePresent) {
    return {
      kind: "unavailable",
      reasonCode: "pipe-not-found",
      detail: "未找到 broker 管道：强档不可用，拒绝执行（不回退宿主）。",
    };
  }
  if (input.connectErrorCode !== undefined && input.connectErrorCode !== null) {
    return {
      kind: "unavailable",
      reasonCode: "connect-failed",
      detail: `连接 broker 失败（${input.connectErrorCode}）：拒绝执行（不回退宿主）。`,
    };
  }
  return { kind: "available" };
}
