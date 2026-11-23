/**
 * D6-E2（2026-11-23）：MCP stdio 是当前唯一"已装配且会把内容送出进程"的出口。
 *
 * 本文件钉住：结果序列化后必须先过四态敏感扫描；非 clean ⇒ **不释放正文**，
 * 只回 JSON-RPC 错误（错误信息不含原文）；普通结果照常返回；审计端口可观测。
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

function fakeBridge(outcome: McpBridgeCallOutcome): McpToolBridge {
  return {
    listTools: () => [],
    callTool: async () => outcome,
    closeSession: () => undefined,
  } as unknown as McpToolBridge;
}

async function runSession(input: {
  readonly outcome: McpBridgeCallOutcome;
  readonly auditSink?: (record: {
    readonly jsonRpcId: string | number | null;
    readonly outcome: "sensitive" | "incomplete" | "error";
    readonly matchedRuleIdentifiers: readonly string[];
  }) => void;
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
    ...(input.auditSink === undefined ? {} : { outboundContentScanAuditSink: input.auditSink }),
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

const SECRET = "sk-abcdefghijklmnop1234567890";

describe("D6-E2：MCP 出站内容扫描", () => {
  it("① 结果含密钥 ⇒ 回 JSON-RPC 错误，stdout 不含原文", async () => {
    const messages = await runSession({
      outcome: {
        isError: false,
        errorCode: null,
        structuredContent: { taskIdentifier: "task-1" },
        textContent: `总结：token=${SECRET}`,
      },
    });
    const errorMessage = messages.find((message) => message["error"] !== undefined);
    expect(errorMessage).toBeDefined();
    expect(JSON.stringify(errorMessage)).not.toContain(SECRET);
    expect(JSON.stringify(messages)).not.toContain(SECRET);
    expect((errorMessage?.["error"] as { code?: number })?.code).toBe(-32010);
  });

  it("② 普通结果 ⇒ 原样返回", async () => {
    const messages = await runSession({
      outcome: {
        isError: false,
        errorCode: null,
        structuredContent: { taskIdentifier: "task-1" },
        textContent: "任务已完成，耗时 1.2s",
      },
    });
    expect(messages[0]?.["result"]).toBeDefined();
    expect(JSON.stringify(messages[0])).toContain("耗时 1.2s");
  });

  it("③ 审计端口收到判定（不含正文）", async () => {
    const records: Array<{ outcome: string; identifiers: readonly string[] }> = [];
    await runSession({
      outcome: {
        isError: false,
        errorCode: null,
        structuredContent: {},
        textContent: `token=${SECRET}`,
      },
      auditSink: (record) =>
        records.push({ outcome: record.outcome, identifiers: record.matchedRuleIdentifiers }),
    });
    expect(records.length).toBe(1);
    expect(records[0]?.outcome).toBe("sensitive");
    expect(records[0]?.identifiers.length).toBeGreaterThan(0);
  });
});
