# ADR-0072 只读运行记录快照（REMOTE-01-01）

- 状态：部分采纳（快照构造 + 控制面入口；不可变存储与投递未做）
- 日期：2026-10-28
- 来源：[REMOTE-01](../tasks/REMOTE01_SCOPED_RUN_EVIDENCE_EXPORT.md) 检查点 01
- 相关：ADR-0047（报告索引）、ADR-0070（外发门禁）

## 1. 背景

卡内要求：增加 `requestRunEvidence` 操作，经项目控制面出具**不可变** `EvidenceSnapshot`；
绑定 request / project / conversation / 选定 message / 时间区间 / snapshotRevision / capturedAt /
lastObservedAt / sourceAgentInstanceIdentifiers / 来源类型 / 记录引用；
**来源必须分开登记**（用户原话、模型自述、工具调用、真实工具结果、产物登记、审查结论）；
无证据标 `unknown`；遗漏/脱敏/截断显式标记；只含已保存可展示记录，**不生成或索取隐藏思维链**；
默认原文摘录、摘要必须注明派生；离线只是 last-known，**禁止标实时**。

实测：仓库里**没有** `requestRunEvidence`，也没有快照契约。数据是散的：mission 摘要/任务链、
运行历史（tool-call / tool-failure / model-note / checkpoint）、产物登记、报告索引 ——
没有统一口径把它们标成"这是什么来源"，也没有任何内容哈希与不可变语义。

## 2. 契约（冻结）

1. **来源分型**：`user-message | model-claim | tool-call | tool-result | artifact-registration |
   review-conclusion | unknown`。**没有**"隐藏思维链"这一来源类型（结构上不可表达）。
2. **逐条带引用**：每条含 `recordReference`（文件路径或 `#标识`）、`recordedAtIso`、
   `sourceAgentInstanceIdentifier`（可为 null）、`excerptText`。
3. **显式记账**：超过 600 字符 ⇒ 截断并标 `isTruncated`；`isRedacted` 只表示"入库时已脱敏"，
   **不表示**"已通过外发检查"；摘要条目必须标 `isSummaryDerived` 并带 `summaryCoveredEntryCount`。
4. **确定性与不可变**：按 `(recordedAtIso, entryIdentifier)` 排序；
   `contentHash = sha256(规范化 JSON)`（不含本字段）；提供 `verifyEvidenceSnapshotIntegrity`。
5. **不标实时**：`isRealtime` 恒 `false`；`lastObservedAtIso` 取**记录里最新的时间**，
   与 `capturedAtIso`（生成快照的此刻）分开。
6. **来源不可用不伪造**：来源缺失/损坏 ⇒ 只写进 `omissions.reasonCodes`
   （`mission-unavailable` / `run-history-unavailable` / `artifact-store-unavailable` …），
   **不补占位条目**。
7. **时间区间过滤**：区间外的条目丢弃并计入 `omittedEntryCount`；非法区间直接拒绝。

## 3. 生产调用链（源码位置）

```
调用方（本地控制面）
└─ MainController.requestRunEvidence(request)                  packages/core/src/orchestration/main-controller.ts
   ├─ MissionManager.getMissionStatus          → user-message（summary.prompt）+ 任务状态（unknown）
   ├─ RunHistoryStore.read                     → tool-call / tool-result(tool-failure) / model-claim(model-note) / unknown
   ├─ ArtifactRecordStore.read                 → artifact-registration
   ├─ MainAgentReportArchiveIngestor.readIndex → review-conclusion
   └─ buildEvidenceSnapshot(...)               remote-evidence-snapshot.ts
      → 排序 / 截断标记 / 来源汇总 / lastObservedAt / contentHash
```

## 4. 未完成（如实）

- **没有不可变存储**：快照只作为返回值；`snapshotRevision` 只在**进程内**按 requestIdentifier
  递增（重启归零），没有落盘、没有"同 revision 不可覆盖"的存储保证。
- **`messageIdentifiers` 未生效**：请求字段被接受但**没有按消息过滤**（当前没有消息级记录索引）。
- **没有授权绑定**：谁有权请求快照、能看哪些 mission，尚未校验（属 REMOTE-01-02）。
- **不脱敏**：默认原文摘录（符合卡内），但投递前必须过 SEC-02-04 外发门禁；本层不替代它。
- **来源粒度粗**：运行历史事件没有 agent/任务归属，`sourceAgentInstanceIdentifier` 多为 null；
  任务状态没有独立时间戳，只能取 mission 创建时间（摘录里已注明）。
- **未验证**：没有跑过任何一条构造路径（正常/时间过滤/截断/来源缺失/哈希校验）。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
