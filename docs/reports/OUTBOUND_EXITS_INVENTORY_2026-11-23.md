# 外发出口清单（D6 落地，2026-11-23）

> D6 裁决：保留远程能力设计，**首版延后真实远端投递**；现有已装配且会把材料送出授权边界的出口
> **逐一列账**，首次实际发送前校验目的端、资源范围、内容判定与授权 revision；**尚无消费者的路径报告不可用**。

## 总览

| 编号 | 出口 | 是否已装配 | 送出内容 | 内容门禁 | 结论 |
|---|---|---|---|---|---|
| E1 | **模型 Provider 请求** | ✅ 生产装配 | 提示词、工具结果、上下文 | `provider-egress-scan`（默认 `record`，可 `block`） | 已装配；默认只记录**不阻断** |
| E2 | **MCP stdio 服务** | ✅ CLI `mcp-serve` | 工具结果（含 `readFile`/`searchProjectText`/证据查询） | **无** | 已装配；**未接入任何外发门禁** |
| E3 | 远程证据导出服务 | ❌ 无生产消费者 | 证据快照文本 | 有 scope 评估（`evaluateRemoteExportScope`） | **不可用**（仅测试） |
| E4 | 远程投递出站 | ❌ 无生产消费者 | 消息文本 | 操作校验（`validateRemoteDeliveryOperation`） | **不可用**（仅测试） |
| E5 | 会话/权限配置导出 | ✅（本地） | 会话快照、权限配置 | 目标为本地文件（state 目录） | 本地落地，不跨授权边界 |
| E6 | 反馈信箱投递 | ✅（内部） | 反馈消息 | 进程内/子进程 IPC | 内部通道 |
| E7 | TUI/CLI 标准输出 | ✅（本地） | 流式文本、诊断 | 终端本地 | 本地呈现 |

## 证据

### E1 模型 Provider 请求（已装配）
- `packages/core/src/runtime/anthropic-messages-runtime.ts:108`：`mode: options.egressScanMode ?? "record"` —— 默认 `record`；
- `packages/core/src/runtime/provider-egress-scan.ts:70-94`：`off`/`record`/`block` 三态；`block` 命中即拒发；
- OpenAI 兼容运行时同路径（`openai-compatible-runtime.ts` 引入同一扫描）。

**缺口**：默认 `record` 意味着**命中敏感内容仍会发送**（只记录审计）；是否改为 `block` 仍未定（D5 只覆盖执行输出）。
**后继**：在 D6 的"首次实际发送前校验"里明确"Provider 通道默认 block 还是 record"。

### E2 MCP stdio 服务（已装配，未接门禁）
- `packages/tui/src/cli/commands.ts:3908`：`executeMcpServeCommand` → `runMcpStdioSession({ input: process.stdin, output: process.stdout, ... })`；
- `packages/core/src/bridge/mcp-tool-bridge.ts`：桥接 `readFile`、`searchProjectText`、证据查询等工具；
- `packages/core/src/bridge/mcp-stdio-server.ts:100`：`options.output.write(JSON.stringify(message) + "\n")` —— 结果直接写到外部客户端。
- 认证主体：`ASTARRAY_MCP_PRINCIPAL` 环境变量（缺省 `external-harness:stdio`）。

**缺口**：**未调用 `evaluateOutboundContentGate`**（全仓唯一引用在 `public-sdk.ts:722-729` 的再导出，无生产调用点）。
**结论**：这是当前**唯一"已装配且会把文件内容送出进程"的出口**；按 D6 必须在下一次实际外发前接入门禁，或明确声明
"MCP 客户端属于授权边界内"（产品口径待确认）。

### E3 远程证据导出（不可用）
- `RemoteEvidenceExportService`（`remote-evidence-export.ts:340`）需要注入 `send` 端口（`:332`）；
- 全仓检索无生产构造点（仅测试）⇒ **不可用**（D6：尚无消费者的路径报告不可用）。

### E4 远程投递出站（不可用）
- `RemoteDeliveryOutbox`（`remote-delivery-outbox.ts:134`）与 `attemptRemoteDelivery`（`:288`）需要 `RemoteDeliveryTransportPort`（`:121`）；
- 全仓检索无生产构造点（仅测试）⇒ **不可用**。

### E5 本地导出
- `packages/core/src/tools/session-shutdown-and-export.ts:179`、`:263`：写入本地文件（state 目录），目标路径受 workspace/state 边界约束；
- 分类：**本地落地**，不属于"送出授权边界"，但导出内容仍应受敏感扫描（EXEC-01-03 同级要求）——未在本清单展开。

### E6/E7 内部与本地
- 反馈信箱（`feedback-process/mailbox-journal.ts`）与投递（`delivery-worker.ts`）：进程内/子进程 IPC；
- TUI stdout：本地终端。

## 结论与后继（按 D6）

1. **E1**：明确 Provider 通道默认策略（`record` 维持或改 `block`）——产品口径；
2. **E2**：MCP 出口在下一次实际外发前接入 `evaluateOutboundContentGate`（或明确"客户端在授权边界内"），
   并补"越界/过期/撤销 ⇒ 零发送"的受控接收端验证；
3. **E3/E4**：保持"不可用"，**不新增真实网络传输**，直到 D6 的认证目标/平台投递/回执齐备；
4. **E5**：导出内容比照 EXEC-01-03 的扫描口径另行核对（不在本轮范围）。
