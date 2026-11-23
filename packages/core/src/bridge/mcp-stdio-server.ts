/**
 * MCP stdio 会话（BRIDGE-01-02 / ADR-0032）。
 *
 * 按 ADR-0032 冻结：客户端启动子进程，双端通过 stdin/stdout 交换
 * **换行分隔的 JSON-RPC**；stdout 只允许合法 MCP 消息（日志走 stderr）。
 * 仅实现最小面：initialize / tools/list / tools/call 与
 * notifications/cancelled（stdio 下取消以通知表达）。
 */
import type {
  McpBridgePrincipal,
  McpToolBridge,
} from "./mcp-tool-bridge.js";
import { scanSensitiveContent } from "../tools/sensitive-content-scan-contract.js";

/**
 * 首选（最新）协议修订。
 *
 * **2026-10-10 真实客户端验证修正（重要）**：本仓原先只有这一个版本常量，且
 * `initialize` **无条件**回它 ⇒ 真实客户端（`opencode` 与 `pi`）都直接拒绝：
 *
 * ```
 * astarray failed — Server's protocol version is not supported: 2026-07-28
 * ```
 *
 * 实测两个客户端的支持集（从其实现读出，非猜测）：
 *  - `@earendil-works/pi-mcp`：`SUPPORTED_PROTOCOL_VERSIONS =`
 *    `["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]`
 *    （`LATEST_PROTOCOL_VERSION = "2025-11-25"`，它按此值发起请求）；
 *  - `opencode`：同样不接受 `2026-07-28`。
 *
 * ⇒ 按 MCP 规范，服务端若支持客户端请求的版本就**必须回该版本**；
 * 只在完全无交集时才回自己的首选版本（由客户端决定是否断开）。
 * 这正是"脚本化自证"漏掉、只有真实客户端才能暴露的缺陷。
 */
export const MCP_SUPPORTED_PROTOCOL_VERSION = "2026-07-28";

/**
 * 本服务端**实际兼容**的协议修订集合（新→旧）。
 *
 * 前四项取自真实客户端实测支持集，确保互操作；
 * 末项保持本仓既有（也是 ADR-0032 冻结的）首选版本。
 */
export const MCP_COMPATIBLE_PROTOCOL_VERSIONS: readonly string[] = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/**
 * 选择要回给客户端的协议修订（MCP `initialize` 协商）。
 *
 * 规则：**客户端请求的版本若在本服务端兼容集内，就回该版本**（规范要求）；
 * 否则回首选版本，并让 `isRequestedVersionSupported` 如实为 `false`
 * ——调用方据此决定是否断开，而**不是**由服务端单方面宣称"支持"。
 */
export function selectNegotiatedProtocolVersion(requestedVersion: string | null): string {
  if (
    requestedVersion !== null &&
    MCP_COMPATIBLE_PROTOCOL_VERSIONS.includes(requestedVersion)
  ) {
    return requestedVersion;
  }
  return MCP_SUPPORTED_PROTOCOL_VERSION;
}

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpStdioSessionOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  bridge: McpToolBridge;
  principal: McpBridgePrincipal;
  serverName?: string;
  serverVersion?: string;
  /** 输入流结束时是否关闭桥接会话（默认 true：断连即会话收口）。 */
  closeSessionOnInputEnd?: boolean;
  /**
   * D6-E2（2026-11-23）：**MCP 出站内容扫描**。
   *
   * - `block`（默认）：结果序列化后未通过四态扫描 ⇒ 回 JSON-RPC 错误，**不释放正文**；
   * - `record`：只记审计，不阻断（用于受控接收端验证）；
   * - `off`：关闭（仅测试/诊断显式选择）。
   */
  outboundContentScanMode?: "block" | "record" | "off";
  /**
   * RELEASE-01-01（2026-11-23）：**释放前授权钩子**（由可信宿主注入）。
   *
   * 缺省不注入 ⇒ 保持既有行为（仅内容扫描）；生产装配必须注入并实现
   * "权威重读绑定 + 撤销/目的端/资源范围/revision 校验"（可用
   * `evaluateMcpReleaseAgainstStore` 组合）。返回拒绝时只回稳定原因码，不反射正文。
   */
  authorizeRelease?: (input: {
    readonly toolName: string;
    readonly outcome: {
      readonly isError: boolean;
      readonly errorCode: string | null;
      readonly textContent: string;
      readonly structuredContent: Record<string, unknown>;
    };
  }) => Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reasonCodes: readonly string[] }>;
  /** 审计端口：记录被阻断/被记录的外发判定（不含正文）。 */
  outboundContentScanAuditSink?: (record: {
    readonly jsonRpcId: string | number | null;
    readonly outcome: "sensitive" | "incomplete" | "error";
    readonly matchedRuleIdentifiers: readonly string[];
  }) => void;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export async function runMcpStdioSession(
  options: McpStdioSessionOptions,
): Promise<void> {
  const serverName = options.serverName ?? "astarray-mcp-bridge";
  const serverVersion = options.serverVersion ?? "0.1.0";
  /** 已受理请求 id → 该请求创建/涉及的任务标识（用于取消映射）。 */
  const taskIdentifierByRequestId = new Map<string, string>();

  const writeMessage = (message: Record<string, unknown>): void => {
    options.output.write(JSON.stringify(message) + "\n");
  };
  const outboundContentScanMode = options.outboundContentScanMode ?? "block";
  const writeResult = (id: unknown, result: Record<string, unknown>): void => {
    if (outboundContentScanMode !== "off") {
      const scanResult = scanSensitiveContent({ content: JSON.stringify(result) });
      if (scanResult.outcome !== "clean") {
        options.outboundContentScanAuditSink?.({
          jsonRpcId: typeof id === "string" || typeof id === "number" ? id : null,
          outcome: scanResult.outcome,
          matchedRuleIdentifiers: [...scanResult.matchedRuleIdentifiers],
        });
        if (outboundContentScanMode === "block") {
          /** 与 D5 一致：没扫干净不算干净，不释放正文。 */
          writeMessage({
            jsonrpc: "2.0",
            id: id ?? null,
            error: {
              code: -32010,
              message: `出站内容未通过敏感扫描（${scanResult.outcome}）：按 block 策略不释放正文`,
            },
          });
          return;
        }
      }
    }
    writeMessage({ jsonrpc: "2.0", id: id ?? null, result });
  };
  const writeError = (
    id: unknown,
    code: number,
    message: string,
  ): void => {
    writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  };

  let bufferedText = "";
  const handleLine = async (line: string): Promise<void> => {
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeError(null, JSONRPC_PARSE_ERROR, "无法解析 JSON-RPC 消息");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      writeError(null, JSONRPC_INVALID_REQUEST, "JSON-RPC 消息必须是对象");
      return;
    }
    const method = typeof parsed.method === "string" ? parsed.method : null;
    const identifier = parsed.id;
    const isNotification = identifier === undefined || identifier === null;

    if (method === "notifications/cancelled") {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const cancelledRequestId = params["requestId"];
      if (typeof cancelledRequestId === "string") {
        const taskIdentifier = taskIdentifierByRequestId.get(cancelledRequestId);
        if (taskIdentifier !== undefined) {
          // stdio 下取消以通知表达：映射为本地任务取消（取消结果由 query 读取）
          await options.bridge.callTool({
            toolName: "cancel_task",
            arguments: { taskIdentifier },
            principal: options.principal,
          });
          taskIdentifierByRequestId.delete(cancelledRequestId);
        }
      }
      return;
    }
    if (method === "notifications/initialized" || isNotification) {
      // 其他通知不产生响应（规范：通知无 id，不得回应）
      return;
    }
    if (method === "initialize") {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const requestedVersion =
        typeof params["protocolVersion"] === "string"
          ? params["protocolVersion"]
          : null;
      const negotiatedVersion = selectNegotiatedProtocolVersion(requestedVersion);
      writeResult(identifier, {
        protocolVersion: negotiatedVersion,
        /**
         * 只有当**回给客户端的版本就是它请求的版本**时才算"支持其请求"。
         * 此前用 `requestedVersion === MCP_SUPPORTED_PROTOCOL_VERSION` 判断，
         * 会让"请求 2025-11-25、我们回 2025-11-25"这种**成功协商**被误报为
         * `isRequestedVersionSupported: false`（自相矛盾）。
         */
        isRequestedVersionSupported:
          requestedVersion === null || requestedVersion === negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: serverVersion },
      });
      return;
    }
    if (method === "tools/list") {
      writeResult(identifier, { tools: options.bridge.listTools() });
      return;
    }
    if (method === "tools/call") {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const toolName = params["name"];
      if (typeof toolName !== "string" || toolName === "") {
        writeError(identifier, JSONRPC_INVALID_PARAMS, "tools/call 需要 name");
        return;
      }
      const toolArguments =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Record<string, unknown>)
          : {};
      try {
        const outcome = await options.bridge.callTool({
          toolName,
          arguments: toolArguments,
          principal: options.principal,
        });
        if (options.authorizeRelease !== undefined) {
          const decision = await options.authorizeRelease({ toolName, outcome });
          if (!decision.allowed) {
            /** 拒绝只回原因码，不反射结果正文。 */
            writeError(
              identifier,
              JSONRPC_INTERNAL_ERROR,
              `MCP 释放被拒绝：${decision.reasonCodes.join(", ")}`,
            );
            return;
          }
        }
        const createdTaskIdentifier = outcome.structuredContent["taskIdentifier"];
        if (
          !outcome.isError &&
          typeof createdTaskIdentifier === "string" &&
          typeof identifier === "string"
        ) {
          taskIdentifierByRequestId.set(identifier, createdTaskIdentifier);
        }
        writeResult(identifier, {
          content: [{ type: "text", text: outcome.textContent }],
          isError: outcome.isError,
          structuredContent: outcome.structuredContent,
        });
      } catch (error) {
        writeError(
          identifier,
          JSONRPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    writeError(identifier, JSONRPC_METHOD_NOT_FOUND, `未知方法: ${method ?? "null"}`);
  };

  await new Promise<void>((resolve, reject) => {
    let processingChain: Promise<void> = Promise.resolve();
    options.input.on("data", (chunk: Buffer | string) => {
      bufferedText += String(chunk);
      let newlineIndex = bufferedText.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = bufferedText.slice(0, newlineIndex).trim();
        bufferedText = bufferedText.slice(newlineIndex + 1);
        if (line !== "") {
          processingChain = processingChain.then(() => handleLine(line));
        }
        newlineIndex = bufferedText.indexOf("\n");
      }
    });
    options.input.on("error", (error: Error) => reject(error));
    options.input.on("end", () => {
      processingChain
        .then(() => {
          if (options.closeSessionOnInputEnd !== false) {
            // 断连即会话收口：之后的调用一律 bridge-session-closed
            options.bridge.closeSession(options.principal.sessionIdentifier);
          }
          resolve();
        })
        .catch(reject);
    });
  });
}
