# ADR-0087 长期记忆与三级汇报的写入侧检查（SEC-02-06 通道 12 续）

- 状态：部分采纳（写入侧三块已加闸；注入侧仍未覆盖）
- 日期：2026-10-28
- 来源：[SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 12
- 相关：ADR-0086（摘要发布性检查）

## 1. 背景

ADR-0086 给摘要片段加了写入侧闸门，但通道 12 还包括两块**会长期保存派生内容**的存储：

- `agent-individual-memory.appendObservation`（长期记忆，接收方保留的来源观察）；
- `main-agent-report-archive.ingestReport`（三级终端汇报）。

两者此前**没有任何内容检查**：一条含凭据的观察/汇报会被原样写盘，并在未来被读取时进入上下文。

## 2. 契约（冻结）

1. **通用判定**：新增 `tools/content-publishability.ts` 的 `evaluateContentPublishability`
   （与摘要同源：四态扫描 + 规则版本；**结果不含正文**）；
   `summary-publishability.ts` 改为它的薄封装（保持既有调用点稳定）。
2. **记忆写入**：`appendObservation` 在拿锁之前检查 `summary`；
   非 clean ⇒ 抛 `sensitive-content-read-denied`（规则版本 + 原因，**不回显正文**）。
3. **汇报写入**：`ingestReport` 在来源认证之后、内容哈希之前检查
   `report.summary` 与各条 `executedChecks[].command`；非 clean ⇒ 同样拒绝落盘。
4. **失败方向一致**：`incomplete`/`error` 与 `sensitive` 一样拒绝（"没扫完"不是"安全"）。
5. **不脱敏**：命中即拒绝写入，**不**改写后继续保存（避免"看起来保存成功"）。

## 3. 生产调用链（源码位置）

```
AgentIndividualMemoryStore.appendObservation        packages/core/src/orchestration/agent-individual-memory.ts
└─ evaluateContentPublishability(summary)           packages/core/src/tools/content-publishability.ts
   └─ 非 clean ⇒ throw sensitive-content-read-denied（不写入）
MainAgentReportArchiveIngestor.ingestReport         packages/core/src/orchestration/main-agent-report-archive.ts
└─ evaluateContentPublishability(summary + executedChecks commands)
   └─ 非 clean ⇒ throw（不写入）
摘要侧
└─ summary-publishability.ts（薄封装 → 同一通用判定）
```

## 4. 未完成（如实）

- **注入侧仍未覆盖**：摘要/记忆/汇报进入提示词的路径**不存在或未加检查**；
  本检查点只保证"不干净的东西不进存储"。
- **读取侧无检查**：`summary-read-service`、`AgentMemoryArchive` 读取、
  `MainAgentReportReader` 都没有扫描标注。
- **调用方可能把拒绝当普通错误**：没有专门的"内容被扣留"用户提示；
  拒绝表现为 `sensitive-content-read-denied`。
- **没有 UI/诊断入口**：没有计数（记忆/汇报是单条写入，不适合累计）。
- **可能影响既有流程**：若某些历史汇报含被规则命中的文本，写入会失败（fail-closed 的代价）。
- **未验证**：没有跑过"记忆 clean ⇒ 写入""记忆命中 ⇒ 拒绝""汇报命中命令 ⇒ 拒绝"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
