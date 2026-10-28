# ADR-0050 任务分解：本地强制校验 + 显式降级（ALIGN-02-02）

- 状态：已采纳（契约与校验层；模型分解**装配可选、默认关闭**）
- 日期：2026-10-28
- 来源：[ALIGN-02](../tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md) 检查点 02
- 相关：ADR-0049（序列先于 mission）、ADR-0045（提案边界）

## 1. 背景

`handleUserMessage` 原先用 `decomposePromptForScriptedRun` **固定生成 T-001 单节点**，
即"没有规划"。ALIGN-02-02 要求：次级读取任务目标与必要项目摘要，形成**有依赖**的执行节点
及**验收要求**；模型建议必须经**本地** schema/循环/优先级校验后才能提交，
且不能伪造用户最高优先来源。

## 2. 契约（冻结）

1. **候选稿一律不可信**：模型输出只按严格白名单解析（`id`/`description`/`dependsOn`/
   `acceptanceCriteria`/`toolNames`）；出现 `sourceKind`/`priorityTier`/`publisherId`
   等权威字段 ⇒ 直接拒绝，不静默忽略。
2. **本地硬校验**（`task-decomposition-contract.ts`）：
   - 节点 1..12 个；id 唯一且只含 `[A-Za-z0-9._-]`；
   - `description` 与 `acceptanceCriteria` **均不得为空**（验收要求是节点的一部分）；
   - `dependsOn` 必须引用**已存在**的节点，禁止自依赖；DFS 检出环时给出**完整环路**；
   - `toolNames` 必须是**已注册工具**的子集；未声明则授予全部已注册工具（与旧行为一致）。
3. **产出节点的权威属性由本地决定**：`status: "pending"`、`assignedAgentId: null`、
   `taskType: "data"`；分解节点**不是**用户层任务（用户层任务已在 ALIGN-02-01 入序列）。
4. **三种结果必须可区分**（写入 mission 摘要 `taskPlanningOutcome`）：
   - `model`：候选稿通过校验；
   - `single-node-fallback`：有规划器但规划/校验失败 ⇒ 降级单节点 + `taskPlanningFallbackReason`，
     并**即时** `[规划降级]` 告知用户；
   - `legacy-single-node`：未装配规划器（旧行为）——不得说成"已规划"。
5. **规划预算独立**：模型分解默认 120 秒 `AbortSignal.timeout`；超时/无 JSON/解析失败
   ⇒ 按失败处理（降级并记录），**不编造分解**。
6. **默认关闭**：`isModelTaskPlanningEnabled` 缺省 `false`。原因：该路径会真实调用模型，
   而本卡交付口径**不运行模型验证**；默认开启等于把未验证的行为推给所有任务。

## 3. 生产调用链（源码位置）

```
assist 用户消息
└─ MainController.handleUserMessage
   ├─ planTaskDecomposition                                   packages/core/src/orchestration/main-controller.ts
   │  ├─ taskDecompositionDraftProvider（可选）                model-task-decomposition-planner.ts
   │  │  └─ runtime.run(单轮规划提示词, AbortSignal.timeout(120s)) → 抽 JSON
   │  ├─ parseAndValidateTaskDecomposition                    task-decomposition-contract.ts
   │  └─ 失败 ⇒ buildSingleNodeDecomposition + [规划降级] 提示
   ├─ MissionManager.createMission({ taskPlanningOutcome, … }) mission-manager.ts
   └─ 任务链（有依赖节点 + acceptanceCriteria）→ MissionOrchestrator
装配
└─ application-runtime：isModelTaskPlanningEnabled === true 且存在 workerRuntimeFactory 时
   构造 provider（planner:<missionId> + 占位任务节点）；否则不传（legacy-single-node）
```

## 4. 未完成（如实）

- **默认路径仍是单节点**：未开启 `isModelTaskPlanningEnabled` 时不规划（摘要如实标
  `legacy-single-node`）。**"默认执行不再用固定 T-001" 只在开启后才成立** —— 本检查点
  因此**只能算部分交付**。
- **未真实调用模型验证**：提示词、JSON 抽取、降级路径都没有跑过实模型；
  没有验证"合格分解"能被稳定产出。
- **项目摘要来源未接**：`projectSummaryProvider` 端口存在，但装配层未提供
  （规划提示词会明说"无摘要"）。
- **调度未消费**：分解结果仍是 mission 任务链，尚未进入权威序列的 ready set
  （02-03/02-05）。
- **未复用已有分解**：收到重复任务时不会复用旧分解（依赖 02-03 的序列读取）。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收、未调用真实模型。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
