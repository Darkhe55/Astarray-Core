# ADR-0080 模型请求最终出口扫描（接线缺口第 ③ 项 / SEC-02-06 通道 13）

- 状态：部分采纳（两个 runtime 已接；其余适配器未接，默认只记录不拦截）
- 日期：2026-10-28
- 来源：[SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 13、
  [STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ③ 项
- 相关：ADR-0067（四态扫描）、ADR-0071（凭据隔离）

## 1. 背景

通道矩阵的结论是：**模型请求最终装配出口没有任何扫描**。
文件/搜索/Git 入口有 DLP，但摘要、记忆、MCP 结果、子进程输出拼进提示词后，
**最后一道闸不存在**。

实测装配点：`AnthropicMessagesRuntime.run()` 与 `OpenAiCompatibleRuntime.run()` 各自在
`this.fetchImpl(baseUrl, { body: JSON.stringify(requestBody) })` 前构造 `serializedRequestBody` ——
这是**请求体真正离开本机之前**唯一必经的位置。

## 2. 契约（冻结）

1. **三档模式**（`provider-egress-scan.ts`）：
   - `off`：不扫描；
   - **`record`（缺省）**：扫描请求体，命中只**记录**（环形缓冲 100 条 + 可注入审计端口），
     **仍然发送**；
   - `block`：命中即抛 `sensitive-content-read-denied`，**不发送**。
2. **为什么缺省不拦截**：提示词里出现 `token=`/`password=` 这类字符串可能只是正常文本
   （文档、代码、用户原话）；误拦会让模型请求直接失败。**拦截模式需要实测误报率**后由用户显式开启。
3. **只扫请求体，不扫请求头**：`Authorization`/`x-api-key`/`anthropic-version` 是协议要求，
   扫描头部会把每次正常请求都判成敏感。这一条写进代码注释与 ADR，避免日后"顺手补上"。
4. **扫描器同源**：使用 `scanSensitiveContent`（四态、UTF-8 字节、规则版本随结果返回）。
5. **记录自描述**：`providerIdentifier` / 时间 / `outcome` / 规则版本 / 命中规则 /
   限制原因 / 请求体字节数 / 是否拦截；**不含请求体内容**（避免日志变成第二份泄漏源）。
6. **模式不可由模型切换**：只能经运行时选项（装配层/用户）设置。

## 3. 生产调用链（源码位置）

```
AnthropicMessagesRuntime.run / OpenAiCompatibleRuntime.run
└─ serializedRequestBody
   └─ applyProviderEgressScan                      packages/core/src/runtime/provider-egress-scan.ts
      ├─ scanSensitiveContent（四态）
      ├─ 记录（环形缓冲 / auditSink）
      └─ mode=block ⇒ DomainError（fetch 不执行）
   └─ this.fetchImpl(...)  ← 只有放行才走到这里
诊断读取
└─ readProviderEgressScanRecords() / clearProviderEgressScanRecords()
```

## 4. 未完成（如实）

- **其余 provider 适配器未覆盖**：`azure-openai-adapter.ts`、`bedrock-converse-adapter.ts`、
  `anthropic-gemini-adapters.ts` 等**没有**接入本扫描（它们是否也走这两个 runtime 未逐一核实）。
- **默认 `record` 模式的记录可能没人看**：环形缓冲只在进程内，没有 CLI/UI 展示入口。
- **没有持久化/告警**：命中记录不会写盘、不会推送。
- **误报率未知**：没有实测（本窗口不跑）。
- **不覆盖响应侧**：模型返回内容不在本层扫描（入口方向的风险另属通道 7/12/13 的输出侧）。
- **未验证**：没有跑过"clean ⇒ 放行""命中 ⇒ record 记录""block ⇒ 抛错且 fetch 未调用"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
