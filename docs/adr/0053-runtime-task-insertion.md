# ADR-0053 运行中插入：本地判定与安全分支（ALIGN-02-06）

- 状态：部分采纳（判定契约 + 推迟分支已接；安全点注入端口未实现）
- 日期：2026-10-28
- 来源：[ALIGN-02](../tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md) 检查点 06
- 相关：ADR-0049（序列先于 mission）、ADR-0051（单元选择）、ADR-0052（领取与派发）

## 1. 背景

卡内要求：指令窗口只限流/管理**当前活动组**；运行中插入要记录**目标组、锚点、
预期 revision、幂等键**；本地校验后在**安全上下文边界**注入尚未执行部分；
不得重复运行组内已完成任务、**不直接改写已发出的工具调用**；无法在本组合法插入的
后继**保留在同一序列等待下一组**，并给出原因。

实测：`InstructionWindowStore` 只管"指令"的准入/排队/回执（幂等键、容量、revision），
**没有任务组插入**；`DagScheduler` 没有插入任务的能力（只有
`finish/release/block/cancel/reassign/unblock`）；`MissionOrchestrator` 没有对外
"插入任务"的入口。因此"插进正在跑的组"目前**没有可安全落地的执行面**。

## 2. 契约（冻结）

1. **请求严格白名单**：`missionIdentifier` / `requestIdentifier`（幂等键）/ `expectedGroupRevision` /
   `anchorTaskIdentifier` / `title` / `description` / `acceptanceCriteria` / `dependsOn`；
   多一个字段即拒绝（不得塞入 `status`/`priorityTier`/`sourceKind` 等权威字段）。
2. **判定顺序固定**：幂等（同键同内容 ⇒ duplicate；同键异内容 ⇒ conflict）→
   revision（不符 ⇒ stale）→ 锚点存在（否则 invalid-anchor）→ 组是否已关闭 →
   锚点之后是否已有已发出的工具调用。顺序固定是为了**重放**不被误报成 revision 过期。
3. **两类推迟**：组已关闭、锚点之后已有工具调用 ⇒ `deferred-to-next-group`；
   **推迟不是失败**——任务登记进**同一权威序列**，等下一组执行。
4. **`insert-now` 只是判定**：真正注入必须发生在安全上下文边界（`insert-now` 且存在注入端口
   才执行）；**绝不**改写已发出的工具调用，**绝不**重跑组内已完成任务。
5. **保守原则**：组内只要有 `running` 任务，就按"锚点之后已有工具调用"处理（等待下一组）。
6. **不丢任务**：推迟分支失败时抛出，不静默丢弃；幂等键保证重试不会产生第二条任务。

## 3. 生产调用链（源码位置）

```
调用方（主 Agent 提案 / 用户运行中补充）
└─ MainController.requestRuntimeTaskInsertion(payload)                    packages/core/src/orchestration/main-controller.ts
   ├─ parseRuntimeTaskInsertionRequest / decideTaskGroupInsertion          task-group-insertion-contract.ts
   │  └─ 组状态来自 mission 摘要 + 任务链状态（revision 取序列映射）
   ├─ taskGroupInsertionPort（可选）                                       安全点注入（当前未装配）
   └─ 否则 ⇒ TaskSequenceManageController.publishOrInsertTask              登记进同一序列等待下一组
      └─ anchor.predecessorTaskIds = [序列中的用户任务 task-<missionId>]
```

## 4. 未完成（如实）

- **没有生产注入端口**：`taskGroupInsertionPort` 缺省未装配 ⇒ 目前**每个**请求都会
  推迟到下一组（即使判定为 `insert-now`），返回原因里写明了这一点。
- **编排器仍无插入能力**：要真正"插进当前组"，需要 `MissionOrchestrator` 暴露
  "在安全点向 DAG 图插入节点"的接口，并让 `DagScheduler` 支持图变更（含 revision/持久化）。
- **幂等指纹只在进程内**：重启后靠序列任务 id 幂等（同一 requestIdentifier 生成同一
  task id），但"同键异内容"检测在重启后会丢失。
- **`acceptanceCriteria` 未落进序列节点**：`InsertTaskInput.task` 没有该字段（只进了 mission
  任务链），插入任务在序列里的验收要求只体现在 `externalReference`。
- **锚点语义被简化**：mission 任务链的任务 id（如 `T-001`）不在序列里，推迟分支统一以
  用户任务为前驱；精确锚定要等两套记账合并。
- 未做端到端："插入 → 推迟 → 下一组执行"未跑过；未做并发/竞态实测。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
