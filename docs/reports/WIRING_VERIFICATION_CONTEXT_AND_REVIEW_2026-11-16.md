# 上下文与独立审查接线核查（2026-11-16）

对应 `docs/reports/ARCHIVE_AND_WIRING_REVIEW_2026-11-16.md` 的 P2 项：
"主 Agent 与节点上下文装配仍未统一"。

本文只记录**核实结果**，每条都给出可复跑的检索命令与实际位置；不把"能力存在"写成"已启用"。

## 1. 上下文提供者：谁真的调用

| 路径 | 生产调用证据 | 结论 |
|---|---|---|
| 工作路径（Worker Agent） | `mission-orchestrator.ts:1340` 把 `contextPromptProvider` 传给 WorkerAgent；`worker-agent.ts:522-524` 真正调用 `contextPromptProvider({ missionId, agentInstanceId, task })`，并**在必要条件缺失时抛错阻塞**（`context-mandatory-constraint-missing`） | **已接线** |
| 主 Agent 思索路径（ponder） | `main-controller.ts` 该路径直接构造 `systemPrompt`（固定文案）与 `userPrompt: message`，**未见** `contextPromptProvider` 调用 | **未接线**（历史续接不在此路径） |
| 运行时默认提供者 | `application-runtime.ts` `createContextPromptProvider({...})` 的入参中**没有** `contextPacks` / `recalledContextBlocks` | 上下文包与关闭节点回访**未启用**（仅能力存在） |

复核命令：

```powershell
git grep -n 'contextPromptProvider' -- packages/core/src/orchestration/mission-orchestrator.ts packages/core/src/orchestration/worker-agent.ts
Select-String -Path packages/core/src/application/application-runtime.ts -Pattern 'createContextPromptProvider' -Context 0,40
```

## 2. 独立审查：是否真的执行

| 环节 | 证据 | 结论 |
|---|---|---|
| 派发真实审查任务（而非就地写裁决） | `main-controller.ts:3084-3091` 返回 `reviewTask: buildReviewTaskNode({...})`；`mission-orchestrator.ts:1505` 在**安全点**注入该节点 | **已接线** |
| 防递归 | `main-controller.ts:3081` 若任务本身是 `taskType === "review"` ⇒ 不再派生 | **已接线** |
| 产物缺失 ⇒ 不派发、直接返修 | `main-controller.ts:3070-3074` 先做 `evaluateArtifactPrecondition`；不满足则走 `recordAcceptanceVerdict(... "rework")` | **已接线**，且不会产生"通过" |
| 审查报告 → 裁决 | `align03-review-loop-e2e.test.ts`：报告引用产物 ⇒ `merge-ready`；报告返修 ⇒ `rework`；审查任务失败 ⇒ `rework`；报告缺失 ⇒ `rework`（`check:review-report-unreadable`） | **已有 e2e 证据** |
| 闭环状态机（待验收 → 返修 → 通过） | `independent-review-closure.ts` 的 `rework` / `accepted` 分支；`tests/core/align03-independent-review-closure.test.ts` | **已覆盖** |
| 默认开关 | `application-runtime.ts:4344` 仅当 `isIndependentReviewAutoAppointmentEnabled === true` 才开启 | **未擅自切换**（保持缺省关闭） |

## 3. 产物存在性检查不能替代独立验收

- `artifact-precondition.ts` 只回答"送审产物是否存在/可读"，其结论用于**决定是否派发审查**；
- 裁决只能来自审查报告（`independent-review-task.ts` 规定报告格式与裁决行），
  缺报告/失败/不可读一律 `rework`（见上表 e2e 断言）。

即：产物检查是**前置条件**，不是验收结论。

## 4. 未完成 / 未验证（不虚报）

1. **主 Agent 思索路径的历史续接**：未接入上下文提供者；该路径 `missionId` 为 `null`，
   而提供者按 mission 装配，直接接入会绕过个体隔离与预算，需要单独设计（不擅自扩）。
2. **上下文包（contextPacks）与关闭节点回访**：提供者未传这两个入参，能力存在但未启用。
3. 真实运行中的"审查 Worker 执行"仅由 e2e（注入式）证明，**未做真实进程级演练**。

## 5. 结论

- 独立审查这条链：**派发 → 报告 → 裁决 → 闭环**均有生产调用与 e2e 证据，且失败路径 fail-closed；
- 上下文这条链：**工作路径已接线**；主 Agent 思索路径与上下文包/关闭节点回访**未接线**，
  与审查报告的判断一致，本轮**不**宣称"已统一"。
