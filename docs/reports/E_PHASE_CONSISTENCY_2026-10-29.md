# E 阶段一致性自查（2026-10-29，R29）

> 目的：核对 R21–R28 的台账描述与**源码事实**是否一致；把仍在的缺口按
> **已闭合 / 仍缺 / 无法在本窗口闭合** 三类归并。**本检查点不改代码**，只修正/确认文档。

## 1. 逐项核对（以检索为准）

| 入口 | 声明 | 源码事实（检索） | 判定 |
|---|---|---|---|
| mission↔序列 索引写入 | 控制器发布/回填时落盘 | `missionSequenceBindingStore,` 传入控制器（`application-runtime.ts:1782`）；控制器 `persistMissionSequenceBinding` 两处 `void` 调用 | ✅ 已闭合（写入方在） |
| 索引读取（CLI） | 缺省补全 | `MissionSequenceBindingStore.readForMission` 在 `task-ledger-command.ts` 使用 | ✅ 已闭合 |
| 推迟插入入队 | `deferred-to-sequence` 时入队 | `deferredInsertionQueueStore,` 传入控制器（`:1784`）+ 入队路径 | ✅ 已闭合 |
| 推迟插入消费 | 组边界消费 | `taskGroupBoundaryPort`（5 处）+ `consumeDeferredInsertions` + `markConsumed` 调用（2 处：定义与调用） | ✅ 已闭合（**消费 ≠ 派发**仍在） |
| 截断可观察 | 计数 + CLI | `droppedConsumedCount` / `lastDroppedAtIso` + CLI 输出 | ✅ 已闭合 |
| 单任务预检 | 只读预检 | `inspectSingleTaskDispatchPrecheck` + CLI `--task` | ✅ 已闭合（**不派发**） |
| 写回提案 | 只读生成 | `buildWriteBackProposal`（3 处：定义/CLI/汇总） | ✅ 已闭合（**无执行端**） |
| 一屏汇总 | `--summary` | `isSummaryView`（2 处） | ✅ 已闭合 |
| 收据写入 | worker success 落盘 | `completionReceiptStore` 传入控制器 + 调度器 success 分支 `save` | ✅ 已闭合 |
| 收据读取 | 严格模式读 | `completionReceiptReader:`（runtime） | ✅ 已闭合 |
| 裁决写入 | `recordVerdict` 落盘 | `verdictStore.save(`（`independent-review-gate.ts:230`） | ✅ 已闭合（任命无 mission ⇒ 跳过） |
| 裁决读取 | 逐任务 | `completionVerdictStore.read(`（runtime） + `completionVerdictReader:` | ✅ 已闭合 |
| 目标激活 | 唯一开关 | `activateGoalMode` 3 处（定义/接口/返回） | ✅ 已闭合（**无 UI/CLI 调用**仍缺） |
| 契约创建 | 未激活拒绝 | `saveActivated` **仅定义 1 处**（无调用方） | ⚠️ **仍缺**（无控制面入口） |
| 目标门禁 resolver | 缓存解析 | `goalGateCache.resolve` 在 resolver 内 | ✅ 已闭合（**控制面仍无写入方** → 生产恒 null） |
| 恢复对账 | `resumeMission` 调用 | `missionGoalResumeReconciliation` 传入 + `resumeMission` 内调用 | ✅ 已闭合（生产恒 `resume`，因无绑定） |

## 2. 仍缺（本轮确认，不假装已修）

1. **目标模式控制面**：没有 API/CLI 创建契约（`saveActivated` 无调用方）、绑定 mission、
   激活目标模式 ⇒ 目标模式在生产上**永远未激活**，解析器恒 `null`。这是 GOAL-02 的**主要剩余缺口**。
2. **按 taskId 派发**：`requestDispatchByTaskIdentifier` 仍显式拒绝；预检只表达"缺什么"。
3. **写回执行端**：提案不可应用（无审批/审计入口）。
4. **严格模式实测**：`block` 全未实测；探针脚本未执行。
5. **持久化/UI**：扫描记录、截断计数、提案都只到 CLI/内存。

## 3. 无法在本窗口闭合（平台/结构）

- **REMOTE-01**：真实投递、签名向量、回执 API、观察设备均需平台 ⇒ 只能做本地侧。
- **DagScheduler 运行中图变更**：结构性改造，需单独设计（不是接线问题）。
- **运行时行为验证**：本窗口口径为"不运行测试/验收"，所有检查点均为 `implemented-unverified`。

## 4. 台账修正

- 确认 `PLAN_STATUS` R21–R28 的"未做"清单**仍然准确**，无需回改；
- 唯一需要澄清的是 **`saveActivated` 无调用方**（此前只在 ADR-0094 记为"没有 UI/CLI 调用激活入口"，
  现在明确到"连控制面 API 都没有"）；
- **本检查点无代码改动**，因此不产生 `typecheck`/`build` 之外的新证据。

## 5. 验证状态

**静态核对**（检索命令见上表）；**未运行任何代码**；本轮不改源码。
