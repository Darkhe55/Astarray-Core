/**
 * E3-2（2026-11-25）：broker 传输契约的反例优先验证（纯离线）。
 */
import { describe, expect, it } from "vitest";

import {
  buildBrokerPipeName,
  encodeBrokerFrame,
  evaluateBrokerAvailability,
  evaluateBrokerConnection,
  parseBrokerFrame,
} from "../../../packages/core/src/execution/sandbox-broker-transport.js";

const USER_SID = "S-1-5-21-1000";

describe("E3-2 broker 传输契约", () => {
  it("① 管道名按用户确定性派生，且不含原始 SID", () => {
    const first = buildBrokerPipeName(USER_SID);
    expect(first).toBe(buildBrokerPipeName(USER_SID));
    expect(first.startsWith("\\\\.\\pipe\\astarray-sandbox-broker-")).toBe(true);
    expect(first).not.toContain(USER_SID);
    expect(buildBrokerPipeName("S-1-5-21-2000")).not.toBe(first);
  });

  it("② 远程连接一律拒绝（即使 SID 匹配）", () => {
    expect(
      evaluateBrokerConnection({
        authenticatedClientSid: USER_SID,
        brokerBoundUserSid: USER_SID,
        isRemoteConnection: true,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "remote-connection" });
  });

  it("③ 未认证 / SID 不匹配拒绝；匹配接受", () => {
    expect(
      evaluateBrokerConnection({
        authenticatedClientSid: null,
        brokerBoundUserSid: USER_SID,
        isRemoteConnection: false,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "unauthenticated" });
    expect(
      evaluateBrokerConnection({
        authenticatedClientSid: "S-1-5-21-9999",
        brokerBoundUserSid: USER_SID,
        isRemoteConnection: false,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "caller-sid-mismatch" });
    expect(
      evaluateBrokerConnection({
        authenticatedClientSid: USER_SID,
        brokerBoundUserSid: USER_SID,
        isRemoteConnection: false,
      }),
    ).toEqual({ kind: "accepted" });
  });

  it("④ 合法帧可解析；编码后可往返", () => {
    const encoded = encodeBrokerFrame({
      schemaVersion: 1,
      requestIdentifier: "req-1",
      payload: { environmentIdentifier: "node-basic" },
    });
    expect(encoded.endsWith("\n")).toBe(true);
    const parsed = parseBrokerFrame(encoded.trimEnd());
    expect(parsed).toMatchObject({
      kind: "frame",
      envelope: { requestIdentifier: "req-1" },
    });
  });

  it("⑤ 超大帧 ⇒ frame-too-large（不尝试解析）", () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    expect(parseBrokerFrame(oversized)).toMatchObject({
      kind: "rejected",
      reasonCode: "frame-too-large",
    });
  });

  it("⑥ 非法 JSON / 非对象 / 缺字段 / schema 不符 ⇒ 拒绝", () => {
    expect(parseBrokerFrame("{not-json")).toMatchObject({ kind: "rejected", reasonCode: "invalid-json" });
    expect(parseBrokerFrame("[]")).toMatchObject({ kind: "rejected", reasonCode: "invalid-envelope" });
    expect(parseBrokerFrame('{"schemaVersion":1,"payload":{}}')).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-envelope",
    });
    expect(parseBrokerFrame('{"schemaVersion":2,"requestIdentifier":"r","payload":{}}')).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-envelope",
    });
    expect(parseBrokerFrame('{"schemaVersion":1,"requestIdentifier":"r","payload":null}')).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-envelope",
    });
  });

  it("⑦ 管道不存在 / 连接失败 ⇒ 不可用（fail-closed，不回退宿主）", () => {
    expect(evaluateBrokerAvailability({ isPipePresent: false })).toMatchObject({
      kind: "unavailable",
      reasonCode: "pipe-not-found",
    });
    expect(
      evaluateBrokerAvailability({ isPipePresent: true, connectErrorCode: "E_ACCESSDENIED" }),
    ).toMatchObject({ kind: "unavailable", reasonCode: "connect-failed" });
    expect(evaluateBrokerAvailability({ isPipePresent: true })).toEqual({ kind: "available" });
  });
});
