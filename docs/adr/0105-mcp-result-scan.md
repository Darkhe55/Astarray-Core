# ADR-0105 MCP 结果返回前的敏感检查（SEC-02 通道 7 / R17）

- 状态：已采纳（代码层；默认行为不变）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) D 阶段、
  [SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 7
- 相关：ADR-0080（出口扫描）、ADR-0104（装配扫描记录）

## 1. 背景

通道 7 的结论是"MCP 结果**只掩码、不阻断**"：`McpToolBridge` 把结果经 `Redactor` 处理后就返回，
若掩码规则漏检（例如无字段名秘密），内容仍会到模型侧客户端。

## 2. 变更（冻结）

1. `McpToolBridgeOptions` 新增：
   - `resultScanMode?: "off" | "record" | "block"`（**缺省 `record`**）；
   - `onResultScan?: (record) => void`（记录回调，不含正文）。
2. `redactText` 改为"**脱敏 → 检查 → 返回/拒绝**"：
   - 检查对象是**脱敏后**文本（先掩码，避免把已掩掉的原文误报）；
   - `record`：非 clean 时回调记录，**仍返回**；
   - `block`：非 clean ⇒ 抛 `sensitive-content-read-denied`（**不返回结果**）；
   - `off`：旧行为（完全不检查）。
3. 记录内容：`outcome` / 规则版本 / 命中规则 / 限制原因 —— **不含正文**。

## 3. 生产调用链（源码位置）

```
McpToolBridge.queryTask / cancelTask / readResult      packages/core/src/bridge/mcp-tool-bridge.ts
└─ redactText(value)
   ├─ resultRedactionPort.redact（既有掩码）
   ├─ scanSensitiveContent（四态）
   ├─ 非 clean ⇒ onResultScan(record)（record/block 都回调）
   └─ block ⇒ DomainError sensitive-content-read-denied
```

## 4. 未完成（如实）

- **默认 `record` 不阻断**：生产上仍需用户显式切 `block`；误报率未测。
- **只覆盖 MCP 桥的结果摘要**：`summaryPreview` 之外的字段（若有）未逐一检查。
- **没有持久化**：记录只经回调；没有落盘/UI。
- **未运行验证**：没跑过"clean ⇒ 原样返回""命中 ⇒ record 回调仍返回""block ⇒ 抛错"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。

## 6. 口径核对（R46，2026-10-29）

与 ADR-0080（出口扫描）、`SEC02_CHANNEL_MATRIX` §8 对齐：**默认 `record`、`block` 未实测、
覆盖范围仅结果摘要字段**。本文档不再使用任何暗示"block 已验证"的措辞。
