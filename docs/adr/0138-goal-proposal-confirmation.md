# ADR-0138 目标提案与用户确认（K1，2026-10-31）

- 状态：已采纳（内核入口；**模型工具/UI 尚未接**）
- 来源：用户"继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K1
- 相关：ADR-0116（控制面）、ADR-0136（K9/K8/K3）、ADR-0137（K2）

## 1. 背景

卡要求目标是"**用户设立**"的，模型只能提议、不能自定判准或来源。此前只有
`createGoalContract`（宿主直接创建契约），没有"提案 → 用户确认"两段式，也没有
"提案过期/一份提案只能生成一个目标"的约束。

## 2. 设计（冻结）

1. **提案**（`proposeGoalContract`）：
   - 输入 `draft`（objective、requirements、scope、不变量、预算、截止、暂停条件）+
     **harness 注入的 `sourceRequestReference`**；
   - `proposalIdentifier` 由运行时生成（`goal-proposal-<uuid>`）；默认 **30 分钟**过期（可覆盖）；
   - **只落提案**，不落契约、不绑定、不派发。
2. **确认**（`confirmGoalContract`）：
   - 必须 `isUserConfirmation === true`（模型/宿主不得代替）；
   - 必须通过 `saveActivated` 的激活判定（用户 + 已认证 + 显式请求 + 显式开启）；
   - 过期 ⇒ 拒绝；已确认给**不同目标** ⇒ `journal-corrupted`；重复确认**同一目标** ⇒ 幂等；
   - 通过后生成 `GoalContract`（**revision 1**、`supersedesRevision: null`、
     `taskNodeIdentifiers: []` 留给 K2）并写初始状态（复用 ADR-0118）。
3. **存储**：`<state>/goal-mode/proposals/<proposal>.json`（原子写 + 备份；损坏读回 `null`）。

## 3. 调用链（源码位置）

```
runtime.proposeGoalContract                 application-runtime.ts
├─ validateGoalProposal（空目标/无要求/重复标识/非正权重/过期）
└─ GoalContractProposalStore.save
runtime.confirmGoalContract
├─ isUserConfirmation 校验（否则 task-sequence-permission-denied）
├─ 提案存在/未过期/未确认给别的目标
├─ buildGoalContractFromProposal（revision 1）
├─ createGoalContract（saveActivated + 初始状态）
└─ GoalContractProposalStore.markConfirmed
```

## 4. 运行证据

```
npx vitest run tests/core/goal-contract-proposal.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

覆盖：合法提案、空目标/无要求/重复标识/非正权重分别被拒、过期被拒、
契约转换（revision 1、来源与权重保留、任务节点留空）、缺所有者被拒、
提案确认/重复确认幂等/换目标被拒。

## 5. 未完成（如实）

- **没有"模型可调用的工具"**：`proposeGoalContract` 是宿主/内核 API，**未注册为 agent 工具**，
  所以"用户和主 agent 对话时，模型自动提议目标"这条**尚未打通**；
- **没有 UI**：确认动作需要宿主或未来 UI 触发；
- **没有提案列表/撤回**（`proposals` 目录可人工查看，无 CLI）；
- **没有把提案内容展示给用户**的格式化输出；
- 运行时接线（提案落盘、确认生成契约、状态写入）**未做集成测试**。

## 6. 验证状态

提案校验与存储规则：**已运行通过**（7 条单测）；运行时/工具/UI：`implemented-unverified`。
