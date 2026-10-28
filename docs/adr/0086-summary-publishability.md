# ADR-0086 摘要写入前的发布性检查（SEC-02-06 通道 12）

- 状态：部分采纳（写入侧已加闸；摘要仍未接入提示词）
- 日期：2026-10-28
- 来源：[SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 12
- 相关：ADR-0067（四态扫描）

## 1. 背景（实测）

通道 12 的审查结论：`summarization/` **没有任何生产消费者** ——
`summary-generation-service` / `summary-index-store` / `summary-read-service`
只在模块内互相调用；`context-prompt-assembler` 只注入全局决策与局部前沿节点，
**不注入摘要**；`agent-individual-memory` 也未接入提示词。

也就是说：**"摘要被注入模型"这条通道目前不存在**，但它一旦接上，
摘要会带着源内容的凭据风险进入模型上下文。所以先在**写入侧**加闸，
而不是等到注入时才补。

## 2. 契约（冻结）

1. **写入前检查**（`evaluateSummaryPublishability`）：每个摘要片段在
   `appendSummarySource` 之前用 `scanSensitiveContent` 做四态扫描。
2. **不干净就不落盘**：`sensitive` / `incomplete` / `error` ⇒ **跳过该片段**
   （**不脱敏后继续发布**），并计入 `withheldChunkCount` 与 `withheldReasons`。
3. **原因不含正文**：原因只写 `revision` 与规则标识/限制原因，
   **不回显摘要文本**（诊断不成为第二次泄漏）。
4. **不宣称"摘要已安全"**：`clean` 只表示"扫描完成且未命中已知规则"。
5. **失败方向**：扫描器异常 ⇒ 视为不可发布（该片段被拦下），
   不让"扫描失败"变成"照常落盘"。

## 3. 生产调用链（源码位置）

```
advanceSummaryGeneration                       packages/core/src/summarization/summary-generation-service.ts
└─ for fact of factsToPublish
   ├─ evaluateSummaryPublishability(summarizeTextForChunk(fact))   summary-publishability.ts
   │  └─ scanSensitiveContent（四态；UTF-8 字节；规则版本随结果）
   ├─ 非 clean ⇒ withheldChunkCount += 1；withheldReasons.push("revision N: <原因>")；continue
   └─ clean ⇒ appendSummarySource(...)
结果新增字段：withheldChunkCount / withheldReasons
```

## 4. 未完成（如实）

- **摘要仍未接入提示词**：本检查点只保护"写入"，不改变"没有消费者"这一事实；
  通道 12 的"注入点"仍是 0。
- **没有读取侧检查**：`summary-read-service` 返回的视图没有扫描标注；
  若未来直接展示给模型，仍需要一道检查。
- **长期记忆/汇报未覆盖**：`agent-individual-memory`、三级报告索引仍是"写入不扫描"。
- **没有 UI/诊断入口**：`withheldChunkCount` 只在返回值里，没进日志/界面。
- **未验证**：没有跑过"clean ⇒ 落盘""命中 ⇒ 拦下并计数""扫描异常 ⇒ 拦下"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
