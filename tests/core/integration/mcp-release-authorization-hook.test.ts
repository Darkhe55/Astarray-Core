/**
 * RELEASE-01-01（2026-11-23）：MCP stdio 的**释放前授权钩子**。
 *
 * 宿主注入 `authorizeRelease` 后，拒绝必须只回稳定原因码，且 stdout 不出现结果正文。
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type {
  McpBridgeCallOutcome,
  McpBridgePrincipal,
  McpToolBridge,
} from "../../../packages/core/src/bridge/mcp-tool-bridge.js";
import { runMcpStdioSession } from "../../../packages/core/src/bridge/mcp-stdio-server.js";

const principal = {
  authenticatedPrincipalIdentifier: "external-harness:stdio-client",
  sessionIdentifier: "mcp-session-stdio",
  agentInstanceId: "agent-1",
} as unknown as McpBridgePrincipal;

const SECRET_FREE_RESULT: McpBridgeCallOutcome = {
  isError: false,
  errorCode: null,
  structuredContent: { taskIdentifier: "task-1" },
  textContent: "任务摘要（不含敏感内容）",
};

function fakeBridge(outcome: McpBridgeCallOutcome): McpToolBridge {
  return {
    listTools: () => [],
    callTool: async () => outcome,
    closeSession: () => undefined,
  } as unknown as McpToolBridge;
}

async function runSession(input: {
  readonly outcome: McpBridgeCallOutcome;
  readonly authorizeRelease?: Parameters<typeof runMcpStdioSession>[0]["authorizeRelease"];
}): Promise<Record<string, unknown>[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const collected: string[] = [];
  stdout.on("data", (chunk: Buffer | string) => collected.push(String(chunk)));
  const session = runMcpStdioSession({
    input: stdin,
    output: stdout,
    bridge: fakeBridge(input.outcome),
    principal,
    ...(input.authorizeRelease === undefined
      ? {}
      : { authorizeRelease: input.authorizeRelease }),
  });
  stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      method: "tools/call",
      params: { name: "query_task", arguments: { taskIdentifier: "task-1" } },
    }) + "\n",
  );
  stdin.end();
  await session;
  return collected
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("RELEASE-01-01：释放前授权钩子", () => {
  it("① 宿主拒绝 ⇒ 回错误且不含结果正文（只给原因码）", async () => {
    const messages = await runSession({
      outcome: SECRET_FREE_RESULT,
      authorizeRelease: async () => ({ allowed: false, reasonCodes: ["authorization-revoked"] }),
    });
    const errorMessage = messages.find((message) => message["error"] !== undefined);
    expect(errorMessage).toBeDefined();
    const serialized = JSON.stringify(errorMessage);
    expect(serialized).toContain("authorization-revoked");
    expect(serialized).not.toContain("任务摘要（不含敏感内容）");
    expect(serialized).not.toContain("task-1");
  });

  it("② 宿主放行 ⇒ 正常返回结果", async () => {
    const messages = await runSession({
      outcome: SECRET_FREE_RESULT,
      authorizeRelease: async () => ({ allowed: true }),
    });
    expect(messages[0]?.["result"]).toBeDefined();
    expect(JSON.stringify(messages[0])).toContain("任务摘要（不含敏感内容）");
  });

  it("③ 未注入钩子 ⇒ 保持既有行为（仅内容扫描）", async () => {
    const messages = await runSession({ outcome: SECRET_FREE_RESULT });
    expect(messages[0]?.["result"]).toBeDefined();
  });

  it("④ 钩子看到工具名与结果（便于按工具/范围判定）", async () => {
    const seen: Array<{ toolName: string; text: string }> = [];
    await runSession({
      outcome: SECRET_FREE_RESULT,
      authorizeRelease: async ({ toolName, outcome }) => {
        seen.push({ toolName, text: outcome.textContent });
        return { allowed: true };
      },
    });
    expect(seen).toEqual([{ toolName: "query_task", text: "任务摘要（不含敏感内容）" }]);
  });
});
