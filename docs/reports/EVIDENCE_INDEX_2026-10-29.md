# 证据索引：A 段"已闭合"条目的源码位置（2026-10-29，R43）

> 用途：复核者不必翻整份 ADR 就能定位实现。
> 行号以 `HEAD = e1d6f201` 为准；**行号会漂移**，以符号名为准、行号仅辅助。
> 本文件**只列静态位置**——所有条目仍未运行验证（`implemented-unverified`）。

## 完成门禁（ADR-0095–0102）

| ADR | 符号 / 位置 | 说明 |
|---|---|---|
| 0095 | `CompletionReceiptStore` `packages/core/src/orchestration/completion-receipt-store.ts:33` | 收据落盘/读取（原子写 + 幂等 + 拒绝覆盖） |
| 0096 | `MissionOrchestratorOptions.completionReceiptStore?` `mission-orchestrator.ts:229` | success 分支先落盘再走门禁 |
| 0097 | `completionReceiptReader` `application-runtime.ts:2247` | 严格模式读取同一份存储 |
| 0098 | `CompletionVerdictStore` `completion-verdict-store.ts:44` | 裁决落盘/读取（rejected 必须有理由） |
| 0100 | `verdictStore.save(` `independent-review-gate.ts:230` | 校验通过后写裁决 |
| 0101 | `doneTaskIdentifiers` `main-controller.ts:2460` | 逐任务对齐裁决 |
| 0102 | `scripts/manual/strict-completion-drill.mjs` | 存储层四态演练（**未执行**） |

## SEC-02（ADR-0103–0107）

| ADR | 符号 / 位置 | 说明 |
|---|---|---|
| 0103 | `contentScan?` `context-prompt-assembler.ts:72` | 装配出口标注 |
| 0104 | `recordPromptContentScan` `context-prompt-assembler.ts:350` → `prompt-scan-journal.ts:33` | 有界记录（通道 12） |
| 0105 | `resultScanMode` `mcp-tool-bridge.ts:116` | MCP 结果可选 block（通道 7） |
| 0106 | `sanitizeLogLine` `infra/log-line-safety.ts:28` | 换行转义（通道 14，仅一处） |
| 0107 | `scripts/manual/egress-false-positive-probe.mjs` | 误报探针（**未执行**） |

## 两套记账（ADR-0108–0115）

| ADR | 符号 / 位置 | 说明 |
|---|---|---|
| 0108 | `MissionSequenceBindingStore` `mission-sequence-binding-store.ts:33` | mission↔序列 索引 |
| 0109 | `task-ledger-command.ts`（`isListBindings` / `isSummaryView`） | CLI 免手填 + 区分 `index-missing` |
| 0110 | `inspectSingleTaskDispatchPrecheck` `task-ledger-bridge.ts:188` | 单任务只读预检 |
| 0111 | `DeferredInsertionQueueStore` `deferred-insertion-queue.ts:47` | 推迟插入队列 |
| 0112 | `taskGroupBoundaryPort?` `mission-orchestrator.ts:236` | 组边界消费（消费≠派发） |
| 0113 | `droppedConsumedCount` `deferred-insertion-queue.ts:38` | 截断可观察 |
| 0114 | `buildWriteBackProposal` `task-ledger-bridge.ts:300` | 写回提案（只读） |
| 0115 | `task-ledger-command.ts`（`--summary`） | 一屏汇总 |

## GOAL-02（ADR-0092–0094、0116–0122）

| ADR | 符号 / 位置 | 说明 |
|---|---|---|
| 0092 | `GoalGateCache` `goal-gate-cache.ts:39`；`GoalContractStore:21`；`GoalMissionBindingStore:30` | 解析器输入 + 同步缓存 |
| 0093 | `missionGoalResumeReconciliation` `application-runtime.ts:1284`；`main-controller.ts:515` | 恢复前对账 |
| 0094 | `resolveGoalModeActivation` `goal-contract.ts`；`saveActivated` `goal-contract-store.ts` | 激活唯一开关、删除死常量 |
| 0116 | `const createGoalContract` `application-runtime.ts:1050` | 控制面最小入口 |
| 0117 | `executeGoalModeStatusCommand` `cli/goal-mode-command.ts:24` | 只读状态视图 |
| 0118 | `goalModeStateStore.write(initialState)` `application-runtime.ts:1095` | 状态初始化 |
| 0119 | `goalTaskGroupBeginPort?` `mission-orchestrator.ts:243` | 组开始/结束 |
| 0120 | `GoalDispatchVerdictJournal` `goal-dispatch-verdict-journal.ts:42` | 判定落盘（有界 200） |
| 0121 | `const closeGoalExperiment` `application-runtime.ts:1258` | 关闭实验（`experiment-closed`） |
| 0122 | `assessGoalRequirementsFromLocalState` `goal-requirement-assessment.ts:32`（调用 `application-runtime.ts:1197`） | 本地 V 计算 |

## 文档工具（ADR-0123–0124）

| ADR | 符号 / 位置 | 说明 |
|---|---|---|
| 0123 | `scripts/manual/taskcard-status-index.mjs` | 任务卡只读索引 |
| 0124 | `BACKLOG_BASELINE_DATE` `taskcard-status-index.mjs:24` | 与台账交叉核对 |

## 只有静态证据的条目（**没有运行验证**）

ADR-0095–0124 全部；尤其：
- `block` 模式（出口/ MCP）**从未实测**，默认仍 `record`；
- 演练脚本（ADR-0102）与误报探针（ADR-0107）**从未执行**；
- 所有 V / 恢复 / 收据 / 裁决路径**没有运行证据**。

## 验证状态

**静态检索**（上述路径与行号即证据）；**未运行任何代码**；本轮**无代码改动**。
