# ADR-0137 要求 ↔ 任务节点映射（K2，2026-10-31）

- 状态：已采纳（映射存储 + 运行时 API + V 评估优先使用动态映射；单测通过）
- 来源：用户"按顺序一个个继续"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K2
- 相关：ADR-0122（本地 V）、ADR-0136（K9/K8/K3）

## 1. 背景

卡 01 要求 `GoalContract.requirements[].taskNodeIdentifiers`（"任务节点映射"），
但仓内**只有读取、没有写入方**：任务节点通常在执行过程中才确定，
而**映射不应该逼着契约升版本**（一升版本，旧证据与预算规则都会受影响）。

## 2. 设计（冻结）

1. 独立存储 `GoalRequirementMappingStore`：
   `<state>/goal-mode/requirement-mappings/<goal>.json`；
   记录 `{goalIdentifier, contractRevision, mappings[], documentRevision, updatedAtIso}`。
2. 运行时 API `bindRequirementTaskMapping({goalIdentifier, requirementIdentifier, taskNodeIdentifiers})`：
   - 契约必须存在、要求必须属于该契约（否则 `mission-not-found` / `invalid-task-chain`）；
   - 写入时记录**当前契约 revision**；
   - 同一要求多次绑定 ⇒ **覆盖**（后写者为准），去重并 trim；
   - **空数组 = 清除**该要求映射。
3. **revision 失效**：`readForContractRevision(goal, revision)` 在 revision 不一致时返回 `null`
   ⇒ 映射自动失效，评估回退到契约静态字段（不猜、不迁移旧映射）。
4. V 评估：`assessGoalRequirementsFromLocalState` 增加可选
   `taskNodeIdentifiersByRequirement`，**动态映射优先**；没有则回退契约静态字段。
5. 运行时组结束计算 V 时读取映射（仅当 revision 一致）并传入。

**不改**：契约 revision、预算、契约 JSON 本身；映射是**增量信息**。

## 3. 调用链（源码位置）

```
runtime.bindRequirementTaskMapping              application-runtime.ts
├─ GoalContractStore.read（契约/revision）
└─ GoalRequirementMappingStore.setMapping
   └─ <state>/goal-mode/requirement-mappings/<goal>.json
组结束算 V：
└─ readForContractRevision(goal, contract.revision)
   └─ assessGoalRequirementsFromLocalState({ taskNodeIdentifiersByRequirement })
      └─ computeGoalPotential
```

## 4. 运行证据

```
npx vitest run tests/core/goal-requirement-mapping.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

覆盖：绑定/覆盖/去重、空数组清除、revision 不一致 ⇒ 失效、
动态映射优先于静态字段、无动态映射时回退静态字段。

## 5. 未完成（如实）

- **没有"自动映射"**：不会根据任务描述/目标文本推断对应关系；映射必须由调用方（宿主/未来 UI/规划器）显式写入；
- **没有解绑单个任务节点**（只能整条覆盖/清除）；
- **没有迁移**：契约升版本后旧映射直接失效，需要重新绑定；
- **运行时路径未集成测试**（`bindRequirementTaskMapping` 的校验与 V 读取只靠单测覆盖纯逻辑）。

## 6. 验证状态

存储与评估规则：**已运行通过**；运行时接线：`implemented-unverified`。
