# ADR-0088 派生内容的读取侧扫描标注（SEC-02-06 通道 12 续）

- 状态：部分采纳（摘要视图与报告读取已标注；记忆读取与注入侧未覆盖）
- 日期：2026-10-28
- 来源：[SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 12
- 相关：ADR-0086/0087（写入侧）

## 1. 背景

写入侧（ADR-0086/0087）保证"不干净的内容不进存储"，但读取方**无法知道**
"手上这份摘要/报告是否被检查过、结论是什么"。读取侧加标注，
让"用了什么、检查结论是什么"在**使用前**可见 —— 这是"可观察"而不是"自动阻断"。

## 2. 契约（冻结）

1. **只标注**：`buildReadSideContentScanLabel` 返回结论（四态）、规则版本、
   命中规则、限制原因、`isEvaluatedAtReadTime: true`、时间、`isClean`；
   **不含正文**。
2. **不改内容**：读取函数返回的 `excerpt` / `summaryText` / 报告对象**逐字不变**。
3. **不阻断**：即使标注为 `sensitive`/`incomplete`/`error`，读取仍成功返回；
   由调用方（未来的注入闸）决定是否使用。
4. **标注是"读取时"结论**：与写入时的检查**不是同一件事**；规则版本可能已升级，
   所以每次读取都重算（字段显式声明 `isEvaluatedAtReadTime`）。
5. **非破坏式扩展**：摘要视图新增字段为**可选**（`contentScan?`），
   旧调用方忽略即可；报告侧新增独立方法 `selectReportsWithScanLabels`，
   **不改** `selectReports` 的返回形状（不改持久化报告 schema）。

## 3. 生产调用链（源码位置）

```
readSummaryOverview / expandSummarySection        packages/core/src/summarization/summary-read-service.ts
└─ contentScan = buildReadSideContentScanLabel(返回的摘要文本)
   └─ tools/read-side-content-scan.ts → scanSensitiveContent（四态）
MainAgentReportReader.selectReportsWithScanLabels  packages/core/src/orchestration/main-agent-report-archive.ts
└─ selectReports(...) → 每条 report + contentScan
```

## 4. 未完成（如实）

- **记忆读取没有标注**：`AgentIndividualMemoryStore.readMemoryArchive` 仍原样返回。
- **注入侧仍未覆盖**：没有"把带标注的内容注入提示词"的路径；标注目前只有调用方能看。
- **没有 UI**：标注不会出现在任何界面。
- **标注不是阻断**：`isClean:false` 时调用方**仍可能**使用该内容（本层不强制）。
- **性能**：每次读取都重新扫描返回文本（有界，最长受摘要/报告体积约束）。
- **未验证**：没有跑过"clean ⇒ 标注 true""命中 ⇒ 标注 false 且内容不变"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
