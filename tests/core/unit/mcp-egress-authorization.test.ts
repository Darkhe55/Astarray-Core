/**
 * RELEASE-01-01（2026-11-23）：MCP 连接授权在**每次结果释放前**复核的反例。
 *
 * 拒绝必须给出稳定原因码，且**不反射正文/资源名**（避免二次泄漏）。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateMcpRelease,
  evaluateMcpReleaseAgainstStore,
  type McpConnectionAuthorizationBinding,
  type McpReleaseRequest,
} from "../../../packages/core/src/bridge/mcp-egress-authorization.js";

const binding: McpConnectionAuthorizationBinding = {
  connectionIdentifier: "conn-1",
  authenticatedPrincipalIdentifier: "principal-user",
  sourceProjectIdentifier: "project-a",
  allowedResourcePrefixes: ["/work/project-a/"],
  targetAccountIdentifier: "client-1",
  authorizationRevision: 3,
  contentRevision: 7,
  ruleSetVersion: 4,
  expiresAtIso: "2026-11-23T23:00:00.000Z",
};

const request: McpReleaseRequest = {
  connectionIdentifier: "conn-1",
  authenticatedPrincipalIdentifier: "principal-user",
  targetAccountIdentifier: "client-1",
  contentRevision: 7,
  ruleSetVersion: 4,
  resourceIdentifiers: ["/work/project-a/docs/readme.md"],
  nowIso: "2026-11-23T22:00:00.000Z",
};

function reasonCodesOf(decision: ReturnType<typeof evaluateMcpRelease>): readonly string[] {
  return decision.allowed ? [] : decision.reasonCodes;
}

describe("RELEASE-01-01：MCP 释放前复核", () => {
  it("① 有效授权 + 范围内资源 ⇒ 放行", () => {
    const decision = evaluateMcpRelease({ request, binding, isRevoked: false });
    expect(decision.allowed).toBe(true);
  });

  it("② 无绑定 ⇒ authorization-missing（项目读取明确拒绝）", () => {
    const decision = evaluateMcpRelease({ request, binding: null, isRevoked: false });
    expect(decision.allowed).toBe(false);
    expect(reasonCodesOf(decision)).toContain("authorization-missing");
  });

  it("③ 已撤销 ⇒ authorization-revoked（即使绑定仍在）", () => {
    const decision = evaluateMcpRelease({ request, binding, isRevoked: true });
    expect(reasonCodesOf(decision)).toContain("authorization-revoked");
  });

  it("④ 过期 ⇒ authorization-expired", () => {
    const decision = evaluateMcpRelease({
      request: { ...request, nowIso: "2026-11-24T00:00:00.000Z" },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(decision)).toContain("authorization-expired");
  });

  it("⑤ 主体/连接/目的端不一致 ⇒ 各自原因码", () => {
    const wrongPrincipal = evaluateMcpRelease({
      request: { ...request, authenticatedPrincipalIdentifier: "principal-other" },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(wrongPrincipal)).toContain("principal-mismatch");
    const wrongConnection = evaluateMcpRelease({
      request: { ...request, connectionIdentifier: "conn-2" },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(wrongConnection)).toContain("connection-mismatch");
    const wrongTarget = evaluateMcpRelease({
      request: { ...request, targetAccountIdentifier: "client-2" },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(wrongTarget)).toContain("target-mismatch");
  });

  it("⑥ 越界资源 ⇒ resource-out-of-scope，且不返回资源名", () => {
    const decision = evaluateMcpRelease({
      request: { ...request, resourceIdentifiers: ["/work/other/secret.txt"] },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(decision)).toContain("resource-out-of-scope");
    if (!decision.allowed) {
      expect(decision.detail).not.toContain("secret.txt");
    }
  });

  it("⑦ 内容/规则版本变化 ⇒ 对应原因码（脱敏后必须重新授权）", () => {
    const contentChanged = evaluateMcpRelease({
      request: { ...request, contentRevision: 8 },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(contentChanged)).toContain("content-revision-mismatch");
    const rulesChanged = evaluateMcpRelease({
      request: { ...request, ruleSetVersion: 5 },
      binding,
      isRevoked: false,
    });
    expect(reasonCodesOf(rulesChanged)).toContain("rule-set-version-mismatch");
  });

  it("⑧ 每次释放都重读权威存储（不缓存旧授权）；读失败 ⇒ 视为撤销（fail-closed）", async () => {
    let currentBinding: McpConnectionAuthorizationBinding | null = binding;
    let revoked = false;
    const store = {
      readBinding: async () => currentBinding,
      isRevoked: async () => revoked,
    };
    expect((await evaluateMcpReleaseAgainstStore({ store, request })).allowed).toBe(true);
    currentBinding = null;
    expect((await evaluateMcpReleaseAgainstStore({ store, request })).allowed).toBe(false);
    currentBinding = binding;
    revoked = true;
    expect((await evaluateMcpReleaseAgainstStore({ store, request })).allowed).toBe(false);
    const failingStore = {
      readBinding: async () => {
        throw new Error("状态存储不可读");
      },
      isRevoked: async () => {
        throw new Error("状态存储不可读");
      },
    };
    const failed = await evaluateMcpReleaseAgainstStore({ store: failingStore, request });
    expect(failed.allowed).toBe(false);
  });
});
