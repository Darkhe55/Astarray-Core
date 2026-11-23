/**
 * RELEASE-01-01（2026-11-23）：MCP 授权仓库与释放判定装配的反例。
 *
 * - 仓库持久化：写入/读取/撤销跨实例可见；
 * - 装配后：有效绑定放行、撤销/过期/异主体拒绝、文件损坏按撤销（fail-closed）。
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
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mcp-auth-"));
  filePath = path.join(baseDirectory, "mcp", "egress-authorizations.json");
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function binding(overrides: Partial<McpConnectionAuthorizationBinding> = {}): McpConnectionAuthorizationBinding {
  return {
    connectionIdentifier: "session-1",
    authenticatedPrincipalIdentifier: "principal-user",
    sourceProjectIdentifier: "project-a",
    allowedResourcePrefixes: ["/work/project-a/"],
    targetAccountIdentifier: "client-1",
    authorizationRevision: 1,
    contentRevision: 1,
    ruleSetVersion: 1,
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function authorizerFor(store: McpEgressAuthorizationStore, nowIso = "2026-11-23T00:00:00.000Z") {
  return createMcpReleaseAuthorizer({
    store,
    connectionIdentifier: "session-1",
    authenticatedPrincipalIdentifier: "principal-user",
    /** 既有场景不涉及资源清单；范围提取由新增用例单独覆盖。 */
    extractResourceIdentifiers: () => [],
    nowIso: () => nowIso,
  });
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

describe("RELEASE-01-01：授权仓库与装配", () => {
  it("① 未写入绑定 ⇒ authorization-missing（缺绑定拒绝）", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    const decision = await authorizerFor(store)(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("authorization-missing");
    }
  });

  it("② 写入有效绑定 ⇒ 放行；跨实例可读（持久化）", async () => {
    const writer = new McpEgressAuthorizationStore({ filePath });
    await writer.writeBinding(binding());
    const reader = new McpEgressAuthorizationStore({ filePath });
    const decision = await authorizerFor(reader)(payload);
    expect(decision.allowed).toBe(true);
  });

  it("③ 撤销 ⇒ 拒绝（即使绑定仍在）", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding());
    await store.revoke("session-1");
    const decision = await authorizerFor(store)(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("authorization-revoked");
    }
  });

  it("④ 过期 ⇒ 拒绝", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding({ expiresAtIso: "2026-01-01T00:00:00.000Z" }));
    const decision = await authorizerFor(store)(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("authorization-expired");
    }
  });

  it("⑤ 主体不一致 ⇒ 拒绝", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding({ authenticatedPrincipalIdentifier: "principal-other" }));
    const decision = await authorizerFor(store)(payload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("principal-mismatch");
    }
  });

  it("⑥ 文件损坏 ⇒ 视为撤销（fail-closed，不当作无授权放行）", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not-json", "utf8");
    const store = new McpEgressAuthorizationStore({ filePath });
    const decision = await authorizerFor(store)(payload);
    expect(decision.allowed).toBe(false);
  });

  it("⑦ 撤销幂等：重复撤销不增加 revision", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding());
    await store.revoke("session-1");
    const before = JSON.parse(await fs.readFile(filePath, "utf8")) as { revision: number };
    await store.revoke("session-1");
    const after = JSON.parse(await fs.readFile(filePath, "utf8")) as { revision: number };
    expect(after.revision).toBe(before.revision);
  });
});

describe("RELEASE-01-01：资源清单与独立目的端", () => {
  it("⑧ 结果含 task 标识 ⇒ 默认提取为 task:<id>；绑定未允许 ⇒ 越界拒绝", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding());
    const authorizer = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "session-1",
      authenticatedPrincipalIdentifier: "principal-user",
      nowIso: () => "2026-11-23T00:00:00.000Z",
    });
    const decision = await authorizer({
      toolName: "query_task",
      outcome: {
        isError: false,
        errorCode: null,
        textContent: "摘要",
        structuredContent: { taskIdentifier: "task-1" },
      },
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("resource-out-of-scope");
    }
  });

  it("⑨ 绑定允许 task: 前缀 ⇒ 放行", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding({ allowedResourcePrefixes: ["task:", "project:"] }));
    const authorizer = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "session-1",
      authenticatedPrincipalIdentifier: "principal-user",
      nowIso: () => "2026-11-23T00:00:00.000Z",
    });
    const decision = await authorizer({
      toolName: "query_task",
      outcome: {
        isError: false,
        errorCode: null,
        textContent: "摘要",
        structuredContent: { taskIdentifier: "task-1", projectIdentifier: "project-a" },
      },
    });
    expect(decision.allowed).toBe(true);
  });

  it("⑩ 宿主提供独立目的端且与绑定不一致 ⇒ target-mismatch", async () => {
    const store = new McpEgressAuthorizationStore({ filePath });
    await store.writeBinding(binding({ allowedResourcePrefixes: ["task:"] }));
    const authorizer = createMcpReleaseAuthorizer({
      store,
      connectionIdentifier: "session-1",
      authenticatedPrincipalIdentifier: "principal-user",
      targetAccountIdentifier: "client-2",
      nowIso: () => "2026-11-23T00:00:00.000Z",
    });
    const decision = await authorizer({
      toolName: "query_task",
      outcome: { isError: false, errorCode: null, textContent: "摘要", structuredContent: {} },
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain("target-mismatch");
    }
  });
});
