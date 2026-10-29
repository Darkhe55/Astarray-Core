# 出口扫描对适配器的覆盖核查（2026-10-29，R16）

> 结论先行：**azure / bedrock / gemini 三个适配器当前不在任何请求路径上**（没有 runtime、
> 没有 transport 消费它们）。因此"给它们接出口扫描"**现在无对象可接**；
> 将来谁把它们接进 runtime，**必须在该 runtime 的请求出口调用 `applyProviderEgressScan`**。
> 本文件记录检索证据，**不新增假装已覆盖的代码**。

## 1. 已接扫描的两个 runtime（唯一网络出口）

| Runtime | 扫描调用点 |
|---|---|
| `anthropic-messages-runtime.ts` | `applyProviderEgressScan`（导入 L19；调用 L195） |
| `openai-compatible-runtime.ts` | `applyProviderEgressScan`（导入 L9；调用 L178） |

两者都在 `fetchImpl(...)` 之前扫描**请求体**（不扫请求头），默认 `record`（只记录不拦截），
`block` 需显式开启（ADR-0080）。

## 2. 三个适配器的实际状态（检索证据）

检索命令：`grep -rn "ProviderProtocolAdapter|AzureOpenAiAdapter|BedrockConverseAdapter|GeminiInteractionsAdapter" packages/core/src --include=*.ts`

结果（11 处命中）：

- `provider-protocol-port.ts`：**只有接口定义** `ProviderProtocolAdapter`（`parseEventStream`，纯解析）；
- `openai-adapters.ts`：`OpenAiResponsesAdapter` / `OpenAiChatCompletionsAdapter`（**无外部 consumer**）；
- `azure-openai-adapter.ts`：`AzureOpenAiAdapter extends OpenAiChatCompletionsAdapter`（**无 consumer**）；
- `bedrock-converse-adapter.ts`：`BedrockConverseAdapter implements ProviderProtocolAdapter`（**无 consumer**）；
- `anthropic-gemini-adapters.ts`：`AnthropicMessagesAdapter` / `GeminiInteractionsAdapter`（**无 consumer**）。

**关键事实**：
1. 所有命中都是**定义/自引用**，没有 `new AzureOpenAiAdapter(...)` 之类的实例化；
2. `ProviderProtocolAdapter` **没有 transport**，它的 `parseEventStream` 只吃增量流、**不发请求**；
3. 因此这些适配器**不构成网络出口**，出口扫描对它们**不适用**（不是"漏接"）。

## 3. 与 SEC-02 通道 13 的关系（如实）

- 通道 13 的扫描**已覆盖两个真实 runtime**；
- 通道矩阵里"azure/bedrock/gemini 未接"应改述为：**"无 runtime ⇒ 当前不适用；接入时必须接"**；
- **不得**把本核查写成"已覆盖三家"。

## 4. 若要接入（未来检查点的工作清单）

1. 为对应协议写 runtime（或让现有 runtime 走 adapter 的 `parseEventStream`）；
2. 在 runtime 的 `fetch`/transport 之前调用 `applyProviderEgressScan`（**同一口径**：只扫 body、
   默认 record）；
3. 若 adapter 自带 transport（目前没有），必须在 transport 层加同一检查；
4. 补一条"该 runtime 已接扫描"的静态断言（当前没有 CI 守卫）。

## 5. 验证状态

**静态核查**（`grep` 证据见 §2）；**未运行任何代码**。
`npm run typecheck` / `eslint` / `build` 未因本次核查改动而受影响（本检查点无代码改动）。
