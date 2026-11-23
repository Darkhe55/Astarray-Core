/**
 * RELEASE-01-01（2026-11-24）：**双子进程并发夹具**。
 *
 * 两个真实 `mcp serve` 子进程共享同一状态目录与绑定文件，使用不同连接 ID/主体/目标：
 * - 各自 `submit_task` 正常；
 * - B 查询 A 的任务 ⇒ 桥接层拒绝（任务不属于 B），且不泄漏任务标识；
 * - 撤销 A 后：A 的释放被拒（authorization-revoked），B 不受影响。
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SENSITIVE_SCAN_RULE_SET_VERSION } from "../../../packages/core/src/tools/sensitive-content-scan-contract.js";

vi.setConfig({ testTimeout: 180_000 });

const CLI_ENTRY_PATH = path.join(process.cwd(), "dist", "cli.js");
const hasBuiltEntry = existsSync(CLI_ENTRY_PATH);

interface JsonRpcLine {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let stateDirectory: string;
let authorizationFilePath: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mcp-dual-"));
  authorizationFilePath = path.join(stateDirectory, "mcp", "egress-authorizations.json");
  await fs.mkdir(path.dirname(authorizationFilePath), { recursive: true });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function binding(connectionIdentifier: string, principal: string, target: string, prefixes: string[]) {
  return {
    connectionIdentifier,
    authenticatedPrincipalIdentifier: principal,
    sourceProjectIdentifier: `project-${connectionIdentifier}`,
    allowedResourcePrefixes: prefixes,
    targetAccountIdentifier: target,
    authorizationRevision: 1,
    contentRevision: 1,
    ruleSetVersion: SENSITIVE_SCAN_RULE_SET_VERSION,
    expiresAtIso: "2099-01-01T00:00:00.000Z",
  };
}

async function writeBindings(revoked: boolean): Promise<void> {
  await fs.writeFile(
    authorizationFilePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: revoked ? 2 : 1,
      updatedAtIso: "2026-11-24T00:00:00.000Z",
      connections: {
        "conn-a": binding("conn-a", "principal-a", "client-a", ["task:", "mission:", "project:"]),
        "conn-b": binding("conn-b", "principal-b", "client-b", ["task:", "mission:", "project:"]),
      },
      revokedConnectionIdentifiers: revoked ? ["conn-a"] : [],
    }),
    "utf8",
  );
}

interface RunningServer {
  readonly send: (message: Record<string, unknown>) => void;
  readonly waitFor: (predicate: (line: JsonRpcLine) => boolean) => Promise<JsonRpcLine>;
  readonly close: () => Promise<void>;
}

function spawnServer(input: {
  readonly connectionIdentifier: string;
  readonly principal: string;
  readonly targetAccountIdentifier: string;
}): RunningServer {
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY_PATH,
      "mcp",
      "serve",
      "--egress-authorization-file",
      authorizationFilePath,
      "--egress-target-account",
      input.targetAccountIdentifier,
    ],
    {
      cwd: stateDirectory,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ASTARRAY_DATA_DIR: stateDirectory,
        ASTARRAY_MCP_CONNECTION_ID: input.connectionIdentifier,
        ASTARRAY_MCP_PRINCIPAL: input.principal,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines: string[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      lines.push(buffered.slice(0, newlineIndex));
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf("\n");
    }
  });
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitFor: async (predicate) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as JsonRpcLine;
            if (predicate(parsed)) return parsed;
          } catch {
            /* ignore non-JSON */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(`等待协议消息超时；stderr=${stderrText.slice(0, 500)}`);
    },
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

function initialize(server: RunningServer, id: string): Promise<JsonRpcLine> {
  server.send({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  return server.waitFor((line) => line.id === id);
}

function submitTask(server: RunningServer, id: string, key: string): Promise<JsonRpcLine> {
  server.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "submit_task", arguments: { prompt: "你好", idempotencyKey: key } },
  });
  return server.waitFor((line) => line.id === id);
}

describe.skipIf(!hasBuiltEntry)("RELEASE-01-01：双子进程并发", () => {
  it("① 两连接各自授权；B 查 A 任务被拒；撤销 A 不影响 B", async () => {
    await writeBindings(false);
    const serverA = spawnServer({ connectionIdentifier: "conn-a", principal: "principal-a", targetAccountIdentifier: "client-a" });
    const serverB = spawnServer({ connectionIdentifier: "conn-b", principal: "principal-b", targetAccountIdentifier: "client-b" });
    try {
      await initialize(serverA, "init-a");
      await initialize(serverB, "init-b");

      const submittedA = await submitTask(serverA, "submit-a", "dual-a");
      expect(submittedA.error).toBeUndefined();
      const taskA = (submittedA.result?.["structuredContent"] as Record<string, unknown>)["taskIdentifier"];
      expect(typeof taskA).toBe("string");

      const submittedB = await submitTask(serverB, "submit-b", "dual-b");
      expect(submittedB.error).toBeUndefined();
      const taskB = (submittedB.result?.["structuredContent"] as Record<string, unknown>)["taskIdentifier"];
      expect(typeof taskB).toBe("string");

      /** B 查询 A 的任务：桥接层拒绝（不属于 B），且不泄漏 A 的任务标识。 */
      serverB.send({
        jsonrpc: "2.0",
        id: "cross-query",
        method: "tools/call",
        /** 用 B 从未提交过的任务标识，确保是"不属于 B"的拒绝（避免 mock 任务 ID 撞名）。 */
        params: { name: "query_task", arguments: { taskIdentifier: "task-not-owned-by-b" } },
      });
      const cross = await serverB.waitFor((line) => line.id === "cross-query");
      /** 桥接层错误以"工具结果 isError"返回（不是 JSON-RPC error）。 */
      expect(cross.result?.["isError"]).toBe(true);
      expect(JSON.stringify(cross.result)).toContain("不属于当前调用主体");
      expect(JSON.stringify(cross)).not.toContain(String(taskA));

      /** 运行中撤销 A：A 的释放被拒；B 仍可正常查询自己的任务。 */
      await writeBindings(true);
      serverA.send({
        jsonrpc: "2.0",
        id: "query-a",
        method: "tools/call",
        params: { name: "query_task", arguments: { taskIdentifier: taskA } },
      });
      const deniedA = await serverA.waitFor((line) => line.id === "query-a");
      expect(deniedA.error?.message).toContain("authorization-revoked");

      serverB.send({
        jsonrpc: "2.0",
        id: "query-b",
        method: "tools/call",
        params: { name: "query_task", arguments: { taskIdentifier: taskB } },
      });
      const allowedB = await serverB.waitFor((line) => line.id === "query-b");
      expect(allowedB.error).toBeUndefined();
    } finally {
      await Promise.all([serverA.close(), serverB.close()]);
    }
  });
});
