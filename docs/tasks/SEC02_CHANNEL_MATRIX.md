# SEC-02-06 类型 × 模型可见通道矩阵

日期：2026-10-28。规则目录版本：`CREDENTIAL_DETECTOR_CATALOG_VERSION = 1`。
类别定义见 [SEC02_CREDENTIAL_COVERAGE](SEC02_CREDENTIAL_COVERAGE.md)（A–G 七组）。
**本文件只登记已核实的调用链**；没有证据的格子写"未覆盖"，不臆造实现。

符号：✅ 已接（阻断）/ 🟡 仅掩码或部分 / ❌ 未覆盖 / — not-applicable（并附检索依据）。

## 1. 通道调用链（入口 → 检测器 → 消费者 → 出口）

| # | 通道 | 入口函数 | 检测器 | 消费者 / 出口 | 状态 |
|---|---|---|---|---|---|
| 1 | 文件全文 | `executeBuiltinTool("readFile")` → `assertSensitiveContentAllowed` | 路径身份 + 四态 DLP（读前 + 全文） | 拒绝（`sensitive-content-read-denied`），不返回正文 | ✅ |
| 2 | 范围读取 / 视图 | 同上（`read-format` 策略**在全文检查之后**生成视图） | 同上 | 同上 | ✅（无独立范围入口） |
| 3 | 搜索命中及前后文 | `searchProjectText` → **本检查点补上的内容扫描** | 路径跳过 + 整文件四态 DLP | 命中即**整文件跳过**，不返回行 | ✅（本轮修复，见 §3） |
| 4 | 目录元数据 | `listDirectory` → `filterSensitiveDirectoryEntries` | 名称规则 | 过滤条目名 | ✅ |
| 5 | Git diff/show/log | `gitReadonlyView` → `assertSensitiveContentReadAllowed(content=stdout)` | 四态 DLP | 拒绝输出 | ✅ |
| 6 | 命令 stdout/stderr | — | — | — | — **无通用 shell 工具**：`builtins.ts` 只有 10 个工具（readFile/listDirectory/writeFileTemporary/createProjectFile/replaceFileContent/backupVault/deleteBackup/taskSequenceStatus/searchProjectText/gitReadonlyView），无 exec/shell/process；git 输出走通道 5 |
| 7 | 插件 / MCP 工具结果 | `mcp-tool-bridge` 结果出口 | `Redactor` + **可选四态扫描**（ADR-0105） | `record` 仍返回；`block` 非 clean ⇒ 拒绝返回 | 🟡 **可选 block（默认 record）**；误报率未测 |
| 8 | 网络响应 | — | — | — | ❌ 无内置 HTTP 工具；MCP 场景见通道 7 |
| 9 | 文档转换 / OCR | `document-view-adapter` / `read-format/*` | 无敏感引用（检索 `sensitive|redact|dlp` 0 命中） | 转换文本若经 readFile 则受通道 1 覆盖；**其他转换入口未核** | ❌ 未覆盖（除 readFile 路径） |
| 10 | 归档解析 | — | — | — | — 无"把归档内容返回模型"的工具 |
| 11 | 缓存命中 | 缓存模块（`infra/cache`） | 无敏感引用 | 缓存只存计算/工具结果元数据 | ❌ 未核 |
| 12 | 恢复记录 / 汇报 / 摘要 / 长期记忆 | `summarization/*` → `evaluateSummaryPublishability`（ADR-0086）；`context-prompt-assembler` / `agent-individual-memory` 仍无检查 | 摘要片段：四态 DLP（**写入侧**）；提示词注入：无（**且当前没有摘要注入点**） | 非 clean 片段**不落盘**并计数 | 🟡 **写入侧三块已加闸**（摘要/长期记忆/三级汇报，ADR-0086/0087）；提示词注入仍无检查；**摘要/报告/记忆读取侧已加标注**（ADR-0088/0089） |
| 13 | 模型请求最终装配出口 | `anthropic-messages-runtime` / `openai-compatible-runtime` 的 `fetch` 之前 | **请求体四态扫描**（ADR-0080） | `record` 记录并发送；`block` 拒绝发送 | 🟡 **两 runtime 已接（默认 record）**；azure/bedrock/gemini **无 runtime ⇒ 不适用**（见核查报告） |
| 14 | 日志 / 诊断导出 | `infra/redaction.ts`（`Redactor`）；`infra/log-line-safety.ts`（ADR-0106） | 掩码规则 + 换行转义/截断 | 掩码后写日志；**一处异常日志已加固** | 🟡 掩码已接；**换行加固仅 1 处**、无统一 logger、ANSI 未处理 |
| 15 | 授权范围外发 | `outbound-content-gate`（SEC-02-04） | 四态扫描结果 + 授权绑定 | **尚无调用方** | ❌ 契约存在、未接线 |

## 2. 类别 × 通道矩阵

> 说明：同一通道内的扫描器对 A–F 六组使用同一份规则目录，因此整行多为同色；
> 差异只出现在"仅字段语义"的组（G）与"掩码而非阻断"的通道（7/14）。

| 类别 \ 通道 | 1 全文 | 2 范围 | 3 搜索 | 4 目录 | 5 Git | 6 子进程 | 7 插件/MCP | 8 网络 | 9 转换/OCR | 10 归档 | 11 缓存 | 12 摘要/记忆 | 13 模型出口 | 14 日志 | 15 外发 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A 厂商 key | ✅ | ✅ | ✅ | — | ✅ | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |
| B VCS/包仓库 | ✅ | ✅ | ✅ | — | ✅ | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |
| C 云凭据 | ✅ | ✅ | ✅ | — | ✅ | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |
| D HTTP/会话 | ✅ | ✅ | ✅ | ✅ | ✅ | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |
| E 私钥/服务账户 | ✅ | ✅ | ✅ | — | ✅ | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |
| F DB/消息/webhook | 🟡 | 🟡 | 🟡 | — | 🟡 | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |
| G 无固定格式秘密 | 🟡 | 🟡 | 🟡 | — | 🟡 | — | 🟡 | ❌ | ❌ | — | ❌ | ❌ | ❌ | 🟡 | ❌ |

- F/G 为 🟡：文件通道的**阻断**依赖字段名规则，无字段名的裸秘密识别不了（覆盖表已写明）。
- 通道 7/14 为 🟡：只有掩码，**没有阻断**；按卡内口径这**不算通过**。
- **通道 13（模型最终出口）**：已由 ADR-0080 在两个真实 runtime（anthropic-messages /
  openai-compatible）的 `fetch` 之前接入请求体扫描；**默认 `record`（只记录不拦截）**，
  `block` 需显式开启。azure / bedrock / gemini 适配器**没有 runtime、不在请求路径上** ⇒
  **当前不适用**；接入时必须接扫描（证据见
  [PROVIDER_ADAPTER_COVERAGE_2026-10-29](../reports/PROVIDER_ADAPTER_COVERAGE_2026-10-29.md)）。

## 3. 本轮修复的通道（证据）

**搜索命中泄漏**：`searchProjectText` 收到 `sensitiveContentPolicy` 却**从未使用**；
只跳过敏感文件名，命中行直接截取 200 字符返回。注释写着"内容疑似凭据 → 丢弃整行"，实际没有调用。
=> 名称正常但内容含凭据的文件会把秘密送给模型。

修复：读取文件后、切行前，对**整份内容**调用
`assertSensitiveContentReadAllowed({canonicalPath, content})`；
命中/未完成/失败（`sensitive-content-read-denied`）⇒ **整文件跳过**，不返回任何行；
其他错误照常抛出（不吞掉装配错误）。

## 4. 检索依据（not-applicable 的证据）

- 无 shell/exec/process 内置工具：`builtins.ts` 的工具名清单（见 §1 通道 6）。
- 无通用 HTTP 工具：同清单；外部能力只经 MCP（通道 7）。
- 无归档读取工具：同清单；`zip` 仅用于工具包安装（本地安装流程，不返回内容给模型）。
- 文档转换：`document-view-adapter.ts` 与 `read-format/*` 检索 `sensitive|redact|dlp` **0 命中**；
  readFile 路径因"先扫描全文再生视图"而受通道 1 覆盖，其他转换入口未核实。

## 5. 待补清单

1. **模型最终出口**（通道 13）：**扫描已接两个 runtime（默认 record）**；仍缺
   `block` 模式误报率实测、其余入口（非这两个 runtime 的调用）、以及"扫描记录"的持久化/呈现。
2. **摘要/记忆/汇报**（通道 12）：**写入侧三块已加闸**（ADR-0086/0087），**读取侧已标注**
   （ADR-0088/0089），注入侧已产出标注并记录（ADR-0103/0104）；仍缺"按标注决定是否注入"的策略与 UI。
3. **MCP/插件结果**（通道 7）：**已有可选 block（ADR-0105，默认 record）**；仍缺误报率实测与默认策略决定。
4. **日志换行注入**（通道 14）：**一处已加固（ADR-0106）**；仍缺"统一 logger 保证全覆盖"、ANSI 控制字符处理与诊断导出完整性。
5. **文档转换/OCR/归档/缓存**（9/10/11）：逐一确认是否存在把内容返回模型的路径。
6. 全部通道的**实际行为**（拒绝/掩码）都还没有运行证据；`block` 模式只有**未执行的探针脚本**（ADR-0107），没有实测数字。

## 6. 验证状态

**implemented-unverified**：本矩阵是**静态调用链核对**，不是运行验证。
通道 3 的修复已写入代码并通过 `typecheck`/`eslint`/`build`，但**没有跑过**任何检索用例。

## 7. 最新状态（2026-10-29，R14–R19 刷新）

| 通道 | 本轮变化 | ADR | 仍缺 |
|---|---|---|---|
| 7 插件/MCP | 结果**可选 block**（默认 record；检查脱敏后文本） | 0105 | 误报率实测、默认策略 |
| 12 摘要/记忆/汇报 | 注入侧标注（`AssembledContextPrompt.contentScan`）+ 环形运行记录 | 0103/0104 | 按标注决定是否注入的策略、持久化、UI |
| 13 模型最终出口 | 两个 runtime 的请求体扫描（默认 record）；适配器核查结论为**不适用** | 0080、核查报告 | block 误报率、其余入口、记录持久化 |
| 14 日志 | 换行转义 + 有界截断（**一处**） | 0106 | 统一 logger、ANSI、导出完整性 |

**结论**：矩阵中 ❌ 的通道 13 已变为"**已接但默认只记录**"；🟡 的 7/12/14 仍是 🟡（有改进、未闭合）。
**仍未闭合**：所有 `block` 都**未实测**；`block` 只在用户显式开启时生效。
