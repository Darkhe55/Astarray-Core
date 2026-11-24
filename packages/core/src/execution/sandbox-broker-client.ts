/**
 * E3-4（2026-11-25）：强档 broker 的**客户端**（可注入传输；纯逻辑可离线验证）。
 *
 * 纪律：
 * - broker 不可用 ⇒ 直接 fail-closed（**不**回退宿主直跑，也**不**自动重试）；
 * - 超时 ⇒ 如实返回 `response-timeout`，**不重发**（副作用可能已发生，重发会重复执行）；
 * - 响应必须与请求标识匹配（错配 ⇒ 拒绝，不猜）；
 * - 无论成功/失败，连接都要关闭（`finally`）。
 *
 * 传输层（命名管道读写）由 Rust/宿主实现注入；本模块只负责协议时序与结果映射。
 */
import {
  encodeBrokerFrame,
  evaluateBrokerAvailability,
  parseBrokerFrame,
} from "./sandbox-broker-transport.js";
import type { SandboxBrokerRequest } from "./sandbox-broker-protocol.js";

export interface BrokerConnectionPort {
  readonly write: (frame: string) => Promise<void>;
  /** 读取一帧（不含换行）；超时/对端关闭返回 null。 */
  readonly readFrame: (timeoutMilliseconds: number) => Promise<string | null>;
  readonly close: () => Promise<void>;
}

export interface BrokerClientPorts {
  readonly isPipePresent: () => Promise<boolean>;
  readonly connect: (pipeName: string) => Promise<BrokerConnectionPort>;
  readonly pipeName: string;
}

export type BrokerClientResult =
  | {
      readonly kind: "accepted";
      /** broker 侧为本次执行分配的句柄（可选；缺省表示 broker 未给出）。 */
      readonly executionHandle: string | null;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode: string;
      readonly detail: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reasonCode: "pipe-not-found" | "connect-failed";
      readonly detail: string;
    }
  | {
      readonly kind: "failed";
      readonly reasonCode: "send-failed" | "response-timeout" | "invalid-response" | "response-mismatch";
      readonly detail: string;
    };

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function requestBrokerSandboxExecution(input: {
  readonly ports: BrokerClientPorts;
  readonly request: SandboxBrokerRequest;
  readonly responseTimeoutMilliseconds?: number;
}): Promise<BrokerClientResult> {
  const responseTimeoutMilliseconds = input.responseTimeoutMilliseconds ?? 30_000;
  const availability = evaluateBrokerAvailability({
    isPipePresent: await input.ports.isPipePresent(),
  });
  if (availability.kind === "unavailable") {
    return { kind: "unavailable", reasonCode: availability.reasonCode, detail: availability.detail };
  }

  let connection: BrokerConnectionPort;
  try {
    connection = await input.ports.connect(input.ports.pipeName);
  } catch (error) {
    return {
      kind: "unavailable",
      reasonCode: "connect-failed",
      detail: `连接 broker 失败：${(error as Error).message}`,
    };
  }

  try {
    try {
      await connection.write(
        encodeBrokerFrame({
          schemaVersion: 1,
          requestIdentifier: input.request.requestIdentifier,
          payload: { request: input.request },
        }),
      );
    } catch (error) {
      return {
        kind: "failed",
        reasonCode: "send-failed",
        detail: `发送请求失败：${(error as Error).message}`,
      };
    }

    const responseFrame = await connection.readFrame(responseTimeoutMilliseconds);
    if (responseFrame === null) {
      return {
        kind: "failed",
        reasonCode: "response-timeout",
        detail: `等待 broker 响应超时（${String(responseTimeoutMilliseconds)} ms）；不重发（避免重复副作用）。`,
      };
    }
    const parsed = parseBrokerFrame(responseFrame);
    if (parsed.kind === "rejected") {
      return {
        kind: "failed",
        reasonCode: "invalid-response",
        detail: `broker 响应非法（${parsed.reasonCode}）：${parsed.detail}`,
      };
    }
    if (parsed.envelope.requestIdentifier !== input.request.requestIdentifier) {
      return {
        kind: "failed",
        reasonCode: "response-mismatch",
        detail: "broker 响应与请求标识不匹配：拒绝（不猜测归属）。",
      };
    }
    const outcome = parsed.envelope.payload["outcome"];
    if (outcome === "accepted") {
      return {
        kind: "accepted",
        executionHandle: readOptionalString(parsed.envelope.payload["executionHandle"]),
      };
    }
    if (outcome === "rejected") {
      return {
        kind: "rejected",
        reasonCode: readOptionalString(parsed.envelope.payload["reasonCode"]) ?? "unknown",
        detail: readOptionalString(parsed.envelope.payload["detail"]) ?? "broker 拒绝执行（未给原因）。",
      };
    }
    return {
      kind: "failed",
      reasonCode: "invalid-response",
      detail: "broker 响应的 outcome 非法（只接受 accepted / rejected）。",
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
