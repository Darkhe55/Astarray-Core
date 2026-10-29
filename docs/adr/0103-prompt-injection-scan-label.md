# ADR-0103 提示词注入侧的扫描标注（SEC-02 通道 12 / R14）

- 状态：已采纳（标注已产出；尚无消费方动作）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R14
- 相关：ADR-0088（读取侧标注）、ADR-0102（演练脚本）

## 1. 背景

通道 12 的写入侧（摘要/记忆/汇报）已加闸、读取侧已可标注（ADR-0086–0089），
但**提示词装配出口**（`assembleContextPrompt`）产出的 `promptText` 没有任何扫描结论：
调用方无法知道"这整段上下文是否检查过"。

## 2. 变更（冻结）

1. `AssembledContextPrompt` 新增**可选** `contentScan?: ReadSideContentScanLabel`；
2. `assembleContextPrompt` 在拼装完成后用 `buildReadSideContentScanLabel(promptText)` 计算；
3. **只标注**：不改 `promptText`、不截断、不阻断；旧调用方忽略该字段即可；
4. `createContextPromptProvider` 返回的就是 `AssembledContextPrompt`，因此装配路径自动携带标注。

## 3. 生产调用链（源码位置）

```
createContextPromptProvider                     packages/core/src/orchestration/context-prompt-assembler.ts
└─ assembleContextPrompt
   ├─ 现有装配（系统规则/必要条件/全局决策/前沿/上下文包）
   └─ contentScan = buildReadSideContentScanLabel(promptText)
      └─ tools/read-side-content-scan.ts → scanSensitiveContent（四态）
```

## 4. 未完成（如实）

- **没有消费方**：worker/assistant 目前**不读** `contentScan`，也不据此记录或阻断；
- **没有可观察记录**：标注只存在于返回值内，不写日志/事件；
- **不覆盖模型请求出口**：真正的出口扫描是 ADR-0080（默认 `record`、不拦截），二者**未合并**；
- **未运行验证**：没跑过"prompt 干净 ⇒ isClean true""命中 ⇒ isClean false 且 promptText 不变"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
