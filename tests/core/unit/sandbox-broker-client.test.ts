/**
 * E3-4（2026-11-25）：broker 客户端时序与失败语义的反例优先验证（假传输，不碰真实管道）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  requestBrokerSandboxExecution,
  type BrokerConnectionPort,
} from "../../../packages/core/src/execution/sandbox-broker-client.js";
import type { SandboxBrokerRequest } from "../../../packages/core/src/execution/sandbox-broker-protocol.js";

const request: SandboxBrokerRequest = {
  requestIdentifier: "req-1",
  environmentIdentifier: "node-basic",
  executablePath: "C:\\Windows\\System32\\cmd.exe",
  arguments: ["/c", "echo x"],
  workingDirectory: "C:\\work",
  resourceLimits: { maximumMemoryBytes: 64 * 1024 * 1024, maximumProcessCount: 4 },
  timeoutMilliseconds: 5_000,
};

function buildPorts(options: {
  readonly isPipePresent?: boolean;
  readonly connectError?: Error;
  readonly writeError?: Error;
  readonly responseFrame?: string | null;
}) {
  const writes: string[] = [];
  const close = vi.fn(async () => undefined);
  const connection: BrokerConnectionPort = {
    write: async (frame) => {
      if (options.writeError !== undefined) throw options.writeError;
      writes.push(frame);
    },
    readFrame: async () => (options.responseFrame === undefined ? null : options.responseFrame),
    close,
  };
  const connect = vi.fn(async () => {
    if (options.connectError !== undefined) throw options.connectError;
    return connection;
  });
  return {
    ports: {
      pipeName: "\\\\.\\pipe\\astarray-sandbox-broker-test",
      isPipePresent: async () => options.isPipePresent !== false,
      connect,
    },
    writes,
    close,
    connect,
  };
}

function responseFrame(payload: Record<string, unknown>, requestIdentifier = "req-1"): string {
  return JSON.stringify({ schemaVersion: 1, requestIdentifier, payload });
}

describe("E3-4 broker 客户端", () => {
  it("① 管道缺失 ⇒ unavailable，且不连接、不写", async () => {
    const harness = buildPorts({ isPipePresent: false });
    const result = await requestBrokerSandboxExecution({ ports: harness.ports, request });
    expect(result).toMatchObject({ kind: "unavailable", reasonCode: "pipe-not-found" });
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.writes).toHaveLength(0);
  });

  it("② 连接失败 ⇒ unavailable（不假装已发送）", async () => {
    const harness = buildPorts({ connectError: new Error("E_ACCESSDENIED") });
    const result = await requestBrokerSandboxExecution({ ports: harness.ports, request });
    expect(result).toMatchObject({ kind: "unavailable", reasonCode: "connect-failed" });
    expect(result).toMatchObject({ detail: expect.stringContaining("E_ACCESSDENIED") });
  });

  it("③ 写失败 ⇒ send-failed，仍会关闭连接", async () => {
    const harness = buildPorts({ writeError: new Error("broken pipe") });
    const result = await requestBrokerSandboxExecution({ ports: harness.ports, request });
    expect(result).toMatchObject({ kind: "failed", reasonCode: "send-failed" });
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("④ 超时 ⇒ response-timeout，且**只发送一次**（不重发）", async () => {
    const harness = buildPorts({ responseFrame: null });
    const result = await requestBrokerSandboxExecution({ ports: harness.ports, request });
    expect(result).toMatchObject({ kind: "failed", reasonCode: "response-timeout" });
    expect(harness.writes).toHaveLength(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("⑤ 响应标识错配 ⇒ response-mismatch（不猜归属）", async () => {
    const harness = buildPorts({
      responseFrame: responseFrame({ outcome: "accepted" }, "req-other"),
    });
    const result = await requestBrokerSandboxExecution({ ports: harness.ports, request });
    expect(result).toMatchObject({ kind: "failed", reasonCode: "response-mismatch" });
  });

  it("⑥ 非法响应（非 JSON / outcome 非法）⇒ invalid-response", async () => {
    const notJson = await requestBrokerSandboxExecution({
      ports: buildPorts({ responseFrame: "{not-json" }).ports,
      request,
    });
    expect(notJson).toMatchObject({ kind: "failed", reasonCode: "invalid-response" });
    const badOutcome = await requestBrokerSandboxExecution({
      ports: buildPorts({ responseFrame: responseFrame({ outcome: "maybe" }) }).ports,
      request,
    });
    expect(badOutcome).toMatchObject({ kind: "failed", reasonCode: "invalid-response" });
  });

  it("⑦ accepted ⇒ 透传 handle；rejected ⇒ 透传 reasonCode/detail（取消/重复都由 broker 判）", async () => {
    const accepted = await requestBrokerSandboxExecution({
      ports: buildPorts({
        responseFrame: responseFrame({ outcome: "accepted", executionHandle: "exec-1" }),
      }).ports,
      request,
    });
    expect(accepted).toEqual({ kind: "accepted", executionHandle: "exec-1" });

    const rejected = await requestBrokerSandboxExecution({
      ports: buildPorts({
        responseFrame: responseFrame({
          outcome: "rejected",
          reasonCode: "duplicate-request",
          detail: "已处理过",
        }),
      }).ports,
      request,
    });
    expect(rejected).toEqual({
      kind: "rejected",
      reasonCode: "duplicate-request",
      detail: "已处理过",
    });
  });
});
