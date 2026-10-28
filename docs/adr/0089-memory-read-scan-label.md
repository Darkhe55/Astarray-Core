# ADR-0089 记忆读取的扫描标注（SEC-02-06 通道 12 收口）

- 状态：部分采纳（记忆读取已标注；注入侧仍无检查）
- 日期：2026-10-28
- 来源：[SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 12
- 相关：ADR-0088（读取侧标注）

## 1. 背景

ADR-0088 给摘要视图与报告读取加了读取时扫描标注，但**长期记忆读取**仍是原样返回：
调用方无法知道这份记忆"是否被检查过"。

## 2. 契约（冻结）

1. 新增 `readMemoryArchiveWithScanLabel(agentInstanceId)`：
   - 与 `readMemoryArchive` **同一读取与校验逻辑**（命名空间、owner 一致性、损坏处理）；
   - 返回 `{ archive, contentScan }`；不存在 ⇒ `{ archive: null, contentScan: null }`；
   - `contentScan` 由**全部观察记录的 summary 拼接**后计算（只标注、不改内容、不阻断）。
2. `readMemoryArchive` **不变**（旧调用方行为逐字不变）。
3. 不新增持久化字段、不改记忆 archive schema。

## 3. 生产调用链（源码位置）

```
AgentIndividualMemoryStore.readMemoryArchiveWithScanLabel   packages/core/src/orchestration/agent-individual-memory.ts
├─ readMemoryArchive（原有读取/校验）
└─ buildReadSideContentScanLabel(observations.map(summary).join("\n"))
   └─ tools/read-side-content-scan.ts → scanSensitiveContent（四态）
```

## 4. 未完成（如实）

- **注入侧仍无路径**：没有任何地方把"带标注的派生内容"注入提示词；
  标注只对调用方可见。
- **没有 UI**：标注不会出现在界面。
- **标注不是阻断**：`isClean:false` 时调用方仍可能使用。
- **无分条标注**：只给整份记忆一个结论，没有"哪条观察命中了什么"。
- **未验证**：没有跑过"无记忆 ⇒ null""有记忆 ⇒ 标注""命中 ⇒ 标注 false 且内容不变"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
