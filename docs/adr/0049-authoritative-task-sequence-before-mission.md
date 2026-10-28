# ADR-0049 用户任务先入权威任务序列，再建 mission 投影（ALIGN-02-01）

- 状态：已采纳（生产接线，assist 路径）
- 日期：2026-10-28
- 来源：[ALIGN-02](../tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md) 检查点 01
- 相关：ADR-0013（任务偏序集）、ADR-0044（身份分层）、ADR-0045（提案边界）、ADR-0049 前置的 ALIGN-01 系列

## 1. 背景

ALIGN-00 的静态基线指出：`main-controller.handleUserMessage` 默认每条消息创建一个 mission，
`decomposePromptForScriptedRun` 固定 T-001；而**版本化偏序集**（`AgentTaskSequenceStore`
/ `TaskSequenceManageController`）虽然实现完整，却**没有任何生产调用方**
（`publishSequence` 全仓零调用）。于是 mission 成了唯一"待办"，而这正是卡内要纠正的：
**任务序列是权威调度来源，mission 只是一次任务组执行的投影**。

本检查点只做"入口顺序与映射"，不改调度算法（那是 02-02 / 02-03 / 02-05）。

## 2. 契约（冻结）

1. **先序列、后 mission**：assist 收到用户消息时，先把用户原始任务登记进目标次级的
   版本化偏序集，登记成功后才创建 mission；登记失败**不创建** mission（不留无权威来源的执行）。
2. **标识映射**（可双向追溯）：
   - 序列：`sequence-<secondaryAgentInstanceId>`（与调度器同一主体）；
   - 任务：`task-<missionId>`（≤120 字标题；原文仍在 mission 摘要里）；
   - `externalReference = mission:<missionId>`，序列节点回指 mission；
   - mission 摘要新增 `taskSequenceIdentifier` + `originalTaskIdentifier`。
3. **来源与层级由本地注入**：来源恒 `user`（认证用户 id），层级 0；**匿名不登记** ——
   没有可信用户来源时宁可没有序列记录，也不伪造。
4. **幂等**：`publishOrInsertTask` 在序列不存在时发布首任务，已存在时按锚点插入；
   同一 `taskId` 已在序列中 ⇒ 返回现状（不重复插入、不递增 revision）。
5. **竞态如实失败**："读后发布"遇到并发创建 ⇒ `invalid-task-chain`（序列已存在），
   **不静默重试**掩盖竞态。
6. **assist 与 devolve 分开**：devolve 由主 Agent 直接调度、**没有下级偏序集**，
   本轮**不**给它编一条"次级序列"（避免把调度方式记错）；devolve 的序列投影留待统一调度时处理。

## 3. 生产调用链（源码位置）

```
用户消息（assist）
└─ MainController.handleUserMessage                          packages/core/src/orchestration/main-controller.ts
   ├─ resolveConversationIdentityForMission                  （ALIGN-01：会话/个体）
   ├─ resolveSecondaryAgentInstanceIdentifier                （调度主体 + 注册为报告来源）
   ├─ registerUserTaskInSequence → TaskSequenceManageController.publishOrInsertTask
   │  └─ AgentTaskSequenceStore（<state>/agent-memory/<secondary>/task-sequences/<sequence>/task-sequence.json）
   ├─ MissionManager.createMission（写入 taskSequenceIdentifier / originalTaskIdentifier）
   └─ launchAssistMission（调度器照旧，读取 mission 任务链；序列化读取待 02-03/05）
```

## 4. 未完成（如实）

- **默认执行仍用固定 T-001**：`decomposePromptForScriptedRun` 未改（02-02）。
- **调度器尚未消费序列**：`ready set` 派发、任务包、原子领取都没接到调度器（02-03/05）；
  因此"序列是权威"目前只体现在**入口登记与映射**，尚未驱动执行。
- **devolve 未投影**：没有 sequence 记录。
- **直投消费者**仍未接（需要真实次级身份，而不是 `scheduler:<missionId>` 这类每 mission 形态）。
- 用户任务与 mission 任务链**尚未自动对账**（`task-<missionId>` 与 mission 内 `T-001` 的对应关系
  只由 `externalReference` 提示，没有强约束）。
- 未运行验证：没有跑过"登记 → mission → 读回映射"的端到端流程，也没有并发竞态实测。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
