/**
 * E3（2026-11-25）：沙箱 broker 请求准入的反例优先验证。
 *
 * 纯判定层：不涉及 IPC/进程；先把"谁能请求什么"钉死。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateSandboxBrokerRequest,
  isPathWithinRoot,
  type SandboxBrokerPolicy,
  type SandboxBrokerRequest,
} from "../../../packages/core/src/execution/sandbox-broker-protocol.js";

const policy: SandboxBrokerPolicy = {
  allowedCallerSid: "S-1-5-21-1000",
  allowedEnvironments: {
    "node-basic": {
      allowedExecutablePaths: ["C:\\Program Files\\nodejs\\node.exe"],
      allowedWorkingDirectoryRoots: ["C:\\work\\project-a"],
    },
  },
  maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  maximumProcessCount: 16,
  maximumTimeoutMilliseconds: 600_000,
};

function buildRequest(overrides: Partial<SandboxBrokerRequest> = {}): SandboxBrokerRequest {
  return {
    requestIdentifier: "req-1",
    environmentIdentifier: "node-basic",
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    arguments: ["-e", "1"],
    workingDirectory: "C:\\work\\project-a",
    resourceLimits: { maximumMemoryBytes: 512 * 1024 * 1024, maximumProcessCount: 8 },
    timeoutMilliseconds: 30_000,
    ...overrides,
  };
}

function evaluate(
  request: SandboxBrokerRequest,
  options: {
    callerSid?: string | null;
    seen?: ReadonlySet<string>;
    overridePolicy?: SandboxBrokerPolicy;
  } = {},
) {
  return evaluateSandboxBrokerRequest({
    request,
    authenticatedCallerSid:
      options.callerSid === undefined ? policy.allowedCallerSid : options.callerSid,
    policy: options.overridePolicy ?? policy,
    ...(options.seen === undefined ? {} : { seenRequestIdentifiers: options.seen }),
  });
}

describe("E3 broker 请求准入", () => {
  it("① 合法请求 ⇒ accepted", () => {
    expect(evaluate(buildRequest())).toEqual({ kind: "accepted" });
  });

  it("② 未认证 / SID 不匹配 ⇒ 拒绝（不信任请求体自报）", () => {
    expect(evaluate(buildRequest(), { callerSid: null })).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-request",
    });
    expect(evaluate(buildRequest(), { callerSid: "S-1-5-21-9999" })).toMatchObject({
      kind: "rejected",
      reasonCode: "caller-sid-mismatch",
    });
  });

  it("③ 未登记环境 ⇒ unknown-environment", () => {
    expect(evaluate(buildRequest({ environmentIdentifier: "unknown-env" }))).toMatchObject({
      kind: "rejected",
      reasonCode: "unknown-environment",
    });
  });

  it("④ 可执行文件不在清单 / 非绝对路径 ⇒ executable-not-allowed", () => {
    expect(
      evaluate(buildRequest({ executablePath: "C:\\Windows\\System32\\cmd.exe" })),
    ).toMatchObject({ kind: "rejected", reasonCode: "executable-not-allowed" });
    expect(evaluate(buildRequest({ executablePath: "node.exe" }))).toMatchObject({
      kind: "rejected",
      reasonCode: "executable-not-allowed",
    });
  });

  it("⑤ 工作目录越界（含 `..` 逃逸）⇒ working-directory-not-allowed", () => {
    expect(
      evaluate(buildRequest({ workingDirectory: "C:\\work\\project-b" })),
    ).toMatchObject({ kind: "rejected", reasonCode: "working-directory-not-allowed" });
    expect(
      evaluate(buildRequest({ workingDirectory: "C:\\work\\project-a\\..\\project-b" })),
    ).toMatchObject({ kind: "rejected", reasonCode: "working-directory-not-allowed" });
  });

  it("⑥ 前缀相同但不是子路径（project-a-evil）⇒ 拒绝", () => {
    expect(
      evaluate(buildRequest({ workingDirectory: "C:\\work\\project-a-evil" })),
    ).toMatchObject({ kind: "rejected", reasonCode: "working-directory-not-allowed" });
    expect(isPathWithinRoot("C:\\work\\project-a-evil", "C:\\work\\project-a", "win32")).toBe(false);
    expect(isPathWithinRoot("C:\\work\\project-a\\src", "C:\\work\\project-a", "win32")).toBe(true);
  });

  it("⑦ 资源/超时只能收紧 ⇒ 超上限拒绝", () => {
    expect(
      evaluate(
        buildRequest({
          resourceLimits: { maximumMemoryBytes: 4 * 1024 * 1024 * 1024, maximumProcessCount: 8 },
        }),
      ),
    ).toMatchObject({ kind: "rejected", reasonCode: "resource-limit-exceeded" });
    expect(
      evaluate(
        buildRequest({
          resourceLimits: { maximumMemoryBytes: 512 * 1024 * 1024, maximumProcessCount: 64 },
        }),
      ),
    ).toMatchObject({ kind: "rejected", reasonCode: "resource-limit-exceeded" });
    expect(evaluate(buildRequest({ timeoutMilliseconds: 3_600_000 }))).toMatchObject({
      kind: "rejected",
      reasonCode: "timeout-exceeded",
    });
  });

  it("⑧ 重复请求标识 ⇒ duplicate-request（不重复副作用）", () => {
    const seen = new Set(["req-1"]);
    expect(evaluate(buildRequest(), { seen })).toMatchObject({
      kind: "rejected",
      reasonCode: "duplicate-request",
    });
  });

  it("⑨ 空请求标识 / 空参数控制字符 ⇒ invalid-request", () => {
    expect(evaluate(buildRequest({ requestIdentifier: "  " }))).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-request",
    });
    expect(evaluate(buildRequest({ arguments: ["ok\u0000bad"] }))).toMatchObject({
      kind: "rejected",
      reasonCode: "invalid-request",
    });
  });
});
