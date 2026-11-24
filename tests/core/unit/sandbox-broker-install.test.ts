/**
 * E3-3（2026-11-25）：broker 安装/运行时契约的反例优先验证。
 */
import { describe, expect, it } from "vitest";

import {
  buildBrokerInstallRecord,
  evaluateBrokerInstallRequest,
  evaluateBrokerRuntimeReadiness,
  evaluateBrokerUninstall,
  parseBrokerInstallRecord,
} from "../../../packages/core/src/execution/sandbox-broker-install.js";
import { buildBrokerPipeName } from "../../../packages/core/src/execution/sandbox-broker-transport.js";

const USER_SID = "S-1-5-21-1000";
const BROKER_VERSION = "0.1.0";

function buildRecord(options: { installMode?: "service" | "scheduled-task" } = {}) {
  return buildBrokerInstallRecord({
    installMode: options.installMode ?? "service",
    boundUserSid: USER_SID,
    brokerVersion: BROKER_VERSION,
    installedAtIso: "2026-11-25T00:00:00.000Z",
  });
}

describe("E3-3 broker 安装与运行时契约", () => {
  it("① 无显式同意 / 未提权 / 未知模式 / 空版本 ⇒ 拒绝安装", () => {
    expect(
      evaluateBrokerInstallRequest({
        hasExplicitUserConsent: false,
        isElevated: true,
        installMode: "service",
        brokerVersion: BROKER_VERSION,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "missing-explicit-consent" });
    expect(
      evaluateBrokerInstallRequest({
        hasExplicitUserConsent: true,
        isElevated: false,
        installMode: "service",
        brokerVersion: BROKER_VERSION,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "not-elevated" });
    expect(
      evaluateBrokerInstallRequest({
        hasExplicitUserConsent: true,
        isElevated: true,
        installMode: "startup-registry",
        brokerVersion: BROKER_VERSION,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "unknown-install-mode" });
    expect(
      evaluateBrokerInstallRequest({
        hasExplicitUserConsent: true,
        isElevated: true,
        installMode: "service",
        brokerVersion: "   ",
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "invalid-version" });
  });

  it("② 合法安装请求 ⇒ allowed；记录含派生管道名", () => {
    expect(
      evaluateBrokerInstallRequest({
        hasExplicitUserConsent: true,
        isElevated: true,
        installMode: "service",
        brokerVersion: BROKER_VERSION,
      }),
    ).toEqual({ kind: "allowed" });
    const record = buildRecord();
    expect(record.pipeName).toBe(buildBrokerPipeName(USER_SID));
    expect(record.boundUserSid).toBe(USER_SID);
  });

  it("③ 缺失 / 损坏 / schema 不符 / 管道名被改 ⇒ 视为未安装或损坏（fail-closed）", () => {
    expect(parseBrokerInstallRecord(null)).toEqual({ kind: "missing" });
    expect(parseBrokerInstallRecord("{not-json")).toMatchObject({ kind: "corrupted" });
    expect(parseBrokerInstallRecord('{"schemaVersion":2}')).toMatchObject({ kind: "corrupted" });
    const tampered = JSON.stringify({
      ...buildRecord(),
      pipeName: buildBrokerPipeName("S-1-5-21-9999"),
    });
    expect(parseBrokerInstallRecord(tampered)).toMatchObject({
      kind: "corrupted",
      detail: expect.stringContaining("管道名与绑定用户不一致"),
    });
  });

  it("④ 记录往返：合法记录解析后与原记录一致", () => {
    const record = buildRecord({ installMode: "scheduled-task" });
    const parsed = parseBrokerInstallRecord(JSON.stringify(record));
    expect(parsed).toEqual({ kind: "record", record });
  });

  it("⑤ 未安装 / 版本不符 / 未运行 ⇒ not-ready（调用方必须拒绝执行）", () => {
    expect(
      evaluateBrokerRuntimeReadiness({
        recordParseResult: { kind: "missing" },
        expectedBrokerVersion: BROKER_VERSION,
        isPipePresent: false,
      }),
    ).toMatchObject({ kind: "not-ready", reasonCode: "not-installed" });

    expect(
      evaluateBrokerRuntimeReadiness({
        recordParseResult: { kind: "record", record: buildRecord() },
        expectedBrokerVersion: "0.2.0",
        isPipePresent: true,
      }),
    ).toMatchObject({ kind: "not-ready", reasonCode: "version-incompatible" });

    expect(
      evaluateBrokerRuntimeReadiness({
        recordParseResult: { kind: "record", record: buildRecord() },
        expectedBrokerVersion: BROKER_VERSION,
        isPipePresent: false,
      }),
    ).toMatchObject({ kind: "not-ready", reasonCode: "broker-not-running" });
  });

  it("⑥ 一切正常 ⇒ ready，并返回记录", () => {
    const record = buildRecord();
    expect(
      evaluateBrokerRuntimeReadiness({
        recordParseResult: { kind: "record", record },
        expectedBrokerVersion: BROKER_VERSION,
        isPipePresent: true,
      }),
    ).toEqual({ kind: "ready", record });
  });

  it("⑦ 卸载幂等：未安装 ⇒ already-absent；损坏 ⇒ 拒绝自动删除", () => {
    expect(evaluateBrokerUninstall({ recordParseResult: { kind: "missing" } })).toEqual({
      kind: "already-absent",
    });
    expect(
      evaluateBrokerUninstall({
        recordParseResult: { kind: "corrupted", detail: "x" },
      }),
    ).toMatchObject({ kind: "rejected" });
    expect(
      evaluateBrokerUninstall({ recordParseResult: { kind: "record", record: buildRecord() } }),
    ).toEqual({ kind: "removed" });
  });
});
