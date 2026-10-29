# ADR-0104 装配标注的运行记录（SEC-02 通道 12 / R15）

- 状态：已采纳（记录已接；无持久化/UI）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R15
- 相关：ADR-0103（装配标注）、ADR-0080（出口扫描）

## 1. 背景

R14 让 `AssembledContextPrompt` 带上 `contentScan`，但**没有消费方**：
标注只存在于返回值内，事后无法回答"某次注入前上下文是否检查过"。

## 2. 变更（冻结）

1. 新增 `prompt-scan-journal.ts`：进程内**环形缓冲**（上限 100）；
   记录 mission / agent / task / 结论 / 规则版本 / 命中规则 / 限制原因 / **isClean** / 时间；
   **不记录提示词正文**（诊断不能成为第二次泄漏）。
2. `createContextPromptProvider` 在返回前调用 `recordPromptContentScan`；
   **记录失败被吞掉**（诊断不得成为装配的单点故障），**不阻断、不改内容**。
3. 公共 SDK 导出 `readPromptContentScanRecords` / `clearPromptContentScanRecords`
   / `MAXIMUM_PROMPT_CONTENT_SCAN_RECORDS` 与 `PromptContentScanRecord`（只读诊断）。

## 3. 生产调用链（源码位置）

```
createContextPromptProvider                     packages/core/src/orchestration/context-prompt-assembler.ts
└─ assembleContextPrompt → assembled.contentScan
   └─ recordPromptContentScan(...)              orchestration/prompt-scan-journal.ts
      └─ 环形缓冲（100 条；无正文）
只读诊断
└─ public-sdk: readPromptContentScanRecords()
```

## 4. 未完成（如实）

- **无持久化**：进程重启即丢；有没有写入磁盘属后续检查点。
- **无 UI**：只有 SDK 读取函数，界面不展示。
- **不阻断**：`isClean:false` 时上下文仍会被注入（与 ADR-0080 的 `record` 口径一致）。
- **与出口扫描未合并**：两处各记一份，可能重复但不会互相校验。
- **未运行验证**：没跑过"装配 ⇒ 记录一条""记录抛错 ⇒ 装配不受影响""超过 100 条先进先出"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
