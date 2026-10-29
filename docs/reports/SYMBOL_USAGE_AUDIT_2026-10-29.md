> 由只读脚本 `scripts/manual/symbol-usage-audit.mjs` 生成；只统计源码文本出现次数，**不验证行为**。

| 符号 | 定义文件 | 总出现 | 定义文件内 | 外部引用文件数 | 判定 |
|---|---|---|---|---|---|
| `GoalGateCache` | packages/core/src/orchestration/goal-gate-cache.ts | 9 | 1 | 3 | 有外部引用 |
| `GoalContractStore` | packages/core/src/orchestration/goal-contract-store.ts | 10 | 1 | 4 | 有外部引用 |
| `GoalMissionBindingStore` | packages/core/src/orchestration/goal-mission-binding-store.ts | 10 | 1 | 4 | 有外部引用 |
| `CompletionReceiptStore` | packages/core/src/orchestration/completion-receipt-store.ts | 12 | 1 | 6 | 有外部引用 |
| `CompletionVerdictStore` | packages/core/src/orchestration/completion-verdict-store.ts | 15 | 1 | 8 | 有外部引用 |
| `MissionSequenceBindingStore` | packages/core/src/orchestration/mission-sequence-binding-store.ts | 9 | 1 | 4 | 有外部引用 |
| `DeferredInsertionQueueStore` | packages/core/src/orchestration/deferred-insertion-queue.ts | 9 | 1 | 4 | 有外部引用 |
| `GoalDispatchVerdictJournal` | packages/core/src/orchestration/goal-dispatch-verdict-journal.ts | 7 | 1 | 3 | 有外部引用 |
| `inspectSingleTaskDispatchPrecheck` | packages/core/src/orchestration/task-ledger-bridge.ts | 4 | 1 | 2 | 有外部引用 |
| `buildWriteBackProposal` | packages/core/src/orchestration/task-ledger-bridge.ts | 6 | 1 | 2 | 有外部引用 |
| `assessGoalRequirementsFromLocalState` | packages/core/src/orchestration/goal-requirement-assessment.ts | 4 | 1 | 2 | 有外部引用 |
| `computeGoalPotential` | packages/core/src/orchestration/goal-contract.ts | 6 | 1 | 3 | 有外部引用 |
| `recordGroupCompletion` | packages/core/src/orchestration/goal-dispatch-gate.ts | 4 | 1 | 3 | 有外部引用 |
| `recordToolCallConsumed` | packages/core/src/orchestration/goal-dispatch-gate.ts | 3 | 1 | 2 | 有外部引用 |
| `sanitizeLogLine` | packages/core/src/infra/log-line-safety.ts | 3 | 2 | 1 | 有外部引用 |
| `recordPromptContentScan` | packages/core/src/orchestration/prompt-scan-journal.ts | 4 | 1 | 2 | 有外部引用 |
| `resolveGoalModeActivation` | packages/core/src/orchestration/goal-contract.ts | 12 | 1 | 3 | 有外部引用 |
| `saveActivated` | packages/core/src/orchestration/goal-contract-store.ts | 5 | 1 | 2 | 有外部引用 |
| `taskGroupBoundaryPort` | packages/core/src/orchestration/mission-orchestrator.ts | 6 | 3 | 2 | 有外部引用 |
| `completionReceiptReader` | packages/core/src/application/application-runtime.ts | 5 | 1 | 3 | 有外部引用 |
| `completionVerdictReader` | packages/core/src/application/application-runtime.ts | 6 | 2 | 3 | 有外部引用 |
| `createGoalContract` | packages/core/src/application/application-runtime.ts | 6 | 5 | 1 | 有外部引用 |
| `closeGoalExperiment` | packages/core/src/application/application-runtime.ts | 4 | 3 | 1 | 有外部引用 |
| `resultScanMode` | packages/core/src/bridge/mcp-tool-bridge.ts | 7 | 6 | 1 | 有外部引用 |
| `contentScan` | packages/core/src/orchestration/context-prompt-assembler.ts | 19 | 9 | 4 | 有外部引用 |
| `isSummaryView` | packages/tui/src/cli/task-ledger-command.ts | 3 | 2 | 1 | 有外部引用 |
| `isListBindings` | packages/tui/src/cli/task-ledger-command.ts | 3 | 2 | 1 | 有外部引用 |
| `executeGoalModeStatusCommand` | packages/tui/src/cli/goal-mode-command.ts | 2 | 1 | 1 | 有外部引用 |
| `executeGoalModeVerdictsCommand` | packages/tui/src/cli/goal-mode-command.ts | 2 | 1 | 1 | 有外部引用 |

合计 29 个符号：未找到 0 个，仅定义处 0 个，有外部引用 29 个。
