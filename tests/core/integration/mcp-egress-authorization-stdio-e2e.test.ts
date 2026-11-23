/**
 * RELEASE-01-01（2026-11-23）：**构建产物上的真实 stdio 子进程**端到端。
 *
 * 夹具：临时状态目录 + 权威绑定文件 + 稳定连接 ID（`ASTARRAY_MCP_CONNECTION_ID`）。
 * 断言：
 * - 已授权 ⇒ `initialize` 正常、`submit_task` 返回任务标识；
 * - 运行中撤销 ⇒ 后续 `query_task` 被拒（错误只含原因码，stdout 不出现任务正文/标识）。
 *
 * 依赖 `dist/cli.js`：未构建时跳过（与既有 dist 依赖用例一致），由 prepack 门禁覆盖。
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SENSITIVE_SCAN_RULE_SET_VERSION } from "../../../packages/core/src/tools/sensitive-content-scan-contract.js";

vi.setConfig({ testTimeout: 120_000 });

const CLI_ENTRY_PATH = path.join(process.cwd(), "dist", "cli.js");
const hasBuiltEntry = existsSync(CLI_ENTRY_PATH);

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mcp-e2e-"));
  await fs.mkdir(path.join(stateDirectory, "mcp"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function bindingFile(revoked: boolean): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    updatedAtIso: "2026-11-23T00:00:00.000Z",
    connections: {
      "conn-e2e": {
        connectionIdentifier: "conn-e2e",
        authenticatedPrincipalIdentifier: "principal-e2e",
        sourceProjectIdentifier: "project-e2e",
        allowedResourcePrefixes: ["task:", "mission:", "project:"],
        targetAccountIdentifier: "client-e2e",
        authorizationRevision: 1,
        contentRevision: 1,
        ruleSetVersion: SENSITIVE_SCAN_RULE_SET_VERSION,
        expiresAtIso: "2099-01-01T00:00:00.000Z",
      },
    },
    revokedConnectionIdentifiers: revoked ? ["conn-e2e"] : [],
  });
}

interface JsonRpcLine {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe.skipIf(!hasBuiltEntry)("RELEASE-01-01：真实 stdio 子进程端到端", () => {
  it("① 已授权 ⇒ submit_task 正常；运行中撤销 ⇒ query_task 被拒且不泄漏标识", async () => {
    const authorizationFilePath = path.join(
      stateDirectory,
      "mcp",
      "egress-authorizations.json",
    );
    await fs.writeFile(authorizationFilePath, bindingFile(false), "utf8");

    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY_PATH,
        "mcp",
        "serve",
        "--egress-authorization-file",
        authorizationFilePath,
        "--egress-target-account",
        "client-e2e",
      ],
      {
        cwd: stateDirectory,
        env: {
          ...process.env,
          NO_COLOR: "1",
          ASTARRAY_DATA_DIR: stateDirectory,
          ASTARRAY_MCP_CONNECTION_ID: "conn-e2e",
          ASTARRAY_MCP_PRINCIPAL: "principal-e2e",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdoutLines: string[] = [];
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0) {
        stdoutLines.push(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    });
    let stderrText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const waitFor = async (predicate: (line: JsonRpcLine) => boolean): Promise<JsonRpcLine> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        for (const line of stdoutLines) {
          try {
            const parsed = JSON.parse(line) as JsonRpcLine;
            if (predicate(parsed)) return parsed;
          } catch {
            /* 非 JSON 行忽略（避免把日志当协议面） */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`等待协议消息超时；stderr=${stderrText.slice(0, 500)}`);
    };

    try {
      send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } });
      const initialized = await waitFor((line) => line.id === "init");
      expect(initialized.result?.["protocolVersion"]).toBeDefined();

      send({
        jsonrpc: "2.0",
        id: "submit",
        method: "tools/call",
        params: { name: "submit_task", arguments: { prompt: "你好", idempotencyKey: "e2e-1" } },
      });
      const submitted = await waitFor((line) => line.id === "submit");
      expect(submitted.error).toBeUndefined();
      const taskIdentifier = (submitted.result?.["structuredContent"] as Record<string, unknown>)[
        "taskIdentifier"
      ];
      expect(typeof taskIdentifier).toBe("string");

      /** 运行中撤销：改写绑定文件后，下一次释放必须被拒。 */
      await fs.writeFile(authorizationFilePath, bindingFile(true), "utf8");

      send({
        jsonrpc: "2.0",
        id: "query",
        method: "tools/call",
        params: { name: "query_task", arguments: { taskIdentifier } },
      });
      const denied = await waitFor((line) => line.id === "query");
      expect(denied.error).toBeDefined();
      expect(denied.error?.message).toContain("authorization-revoked");
      expect(JSON.stringify(denied)).not.toContain(String(taskIdentifier));
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
});
