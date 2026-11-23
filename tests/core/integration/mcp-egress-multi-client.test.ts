/**
 * RELEASE-01-01（2026-11-23）：**双客户端 / 两项目**夹具。
 *
 * 同一权威绑定文件里放两个连接（各自主体、目标账户与资源前缀）：
 * - 各自资源放行，互不串权；
 * - 用 A 的连接 + B 的目标 ⇒ target-mismatch；
 * - A 请求 B 项目资源 ⇒ resource-out-of-scope；
 * - 撤销 A 不影响 B。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  McpEgressAuthorizationStore,
  createMcpReleaseAuthorizer,
} from "../../../packages/core/src/bridge/mcp-egress-authorization-store.js";
import type { McpConnectionAuthorizationBinding } from "../../../packages/core/src/bridge/mcp-egress-authorization.js";

let baseDirectory: string;
let filePath: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mcp-multi-"));
  filePath = path.join(baseDirectory, "mcp", "egress-authorizations.json");
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function bindingFor(
  connectionIdentifier: string,
  principal: string,
  targetAccountIdentifier: string,
  prefixes: string[],
): McpConnectionAuthorizationBinding {
  return {
    connectionIdentifier,
    authenticatedPrincipalIdentifier: principal,
    sourceProjectIdentifier: `project-${connectionIdentifier}`,
    allowedResourcePrefixes: prefixes,
    targetAccountIdentifier,
    authorizationRevision: 1,
    contentRevision: 1,
    ruleSetVersion: 1,
    expiresAtIso: "2099-01-01T00:00:00.000Z",
  };
}

const payload = {
  toolName: "query_task",
  outcome: {
    isError: false,
    errorCode: null,
    textContent: "摘要",
    structuredContent: {},
  },
};

describe("RELEASE-01-01：双客户端 / 两项目", () => {
  it("① 各自资源放行；用 A 的连接 + B 的目标 ⇒ target-mismatch", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(bindingFor("conn-a", "principal-a", "client-a", ["task:alpha:"]));
    await store.writeBinding(bindingFor("conn-b", "principal-b", "client-b", ["task:beta:"]));

    const authorizerA = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "conn-a",
      authenticatedPrincipalIdentifier: "principal-a",
      targetAccountIdentifier: "client-a",
      extractResourceIdentifiers: () => ["task:alpha:1"],
      nowIso: () => "2026-11-24T00:00:00.000Z",
    });
    const authorizerB = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "conn-b",
      authenticatedPrincipalIdentifier: "principal-b",
      targetAccountIdentifier: "client-b",
      extractResourceIdentifiers: () => ["task:beta:1"],
      nowIso: () => "2026-11-24T00:00:00.000Z",
    });
    expect((await authorizerA(payload)).allowed).toBe(true);
    expect((await authorizerB(payload)).allowed).toBe(true);

    const wrongTarget = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "conn-a",
      authenticatedPrincipalIdentifier: "principal-a",
      targetAccountIdentifier: "client-b",
      extractResourceIdentifiers: () => ["task:alpha:1"],
      nowIso: () => "2026-11-24T00:00:00.000Z",
    });
    const decision = await wrongTarget(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("target-mismatch");
    }
  });

  it("② A 请求 B 项目的资源 ⇒ resource-out-of-scope（不串权）", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(bindingFor("conn-a", "principal-a", "client-a", ["task:alpha:"]));
    await store.writeBinding(bindingFor("conn-b", "principal-b", "client-b", ["task:beta:"]));

    const authorizerA = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "conn-a",
      authenticatedPrincipalIdentifier: "principal-a",
      targetAccountIdentifier: "client-a",
      extractResourceIdentifiers: () => ["task:beta:1"],
      nowIso: () => "2026-11-24T00:00:00.000Z",
    });
    const decision = await authorizerA(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("resource-out-of-scope");
    }
  });

  it("③ 撤销 A 不影响 B", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(bindingFor("conn-a", "principal-a", "client-a", ["task:alpha:"]));
    await store.writeBinding(bindingFor("conn-b", "principal-b", "client-b", ["task:beta:"]));
    await store.revoke("conn-a");

    const build = (connectionIdentifier: string, principal: string, target: string) =>
      createMcpReleaseAuthorizer({
        store,
        connectionIdentifier,
        authenticatedPrincipalIdentifier: principal,
        targetAccountIdentifier: target,
        extractResourceIdentifiers: () => [`task:${connectionIdentifier === "conn-a" ? "alpha" : "beta"}:1`],
        nowIso: () => "2026-11-24T00:00:00.000Z",
      });
    expect((await build("conn-a", "principal-a", "client-a")(payload)).allowed).toBe(false);
    expect((await build("conn-b", "principal-b", "client-b")(payload)).allowed).toBe(true);
  });

  it("④ 用 B 的连接 + A 的主体 ⇒ principal-mismatch", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(bindingFor("conn-b", "principal-b", "client-b", ["task:beta:"]));
    const authorizer = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "conn-b",
      authenticatedPrincipalIdentifier: "principal-a",
      targetAccountIdentifier: "client-b",
      extractResourceIdentifiers: () => ["task:beta:1"],
      nowIso: () => "2026-11-24T00:00:00.000Z",
    });
    const decision = await authorizer(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("principal-mismatch");
    }
  });
});
