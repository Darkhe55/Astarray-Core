# ADR-0051 ready set 的工作单元选择（ALIGN-02-03）

- 状态：已采纳（只读选择契约；派发接线未做）
- 日期：2026-10-28
- 来源：[ALIGN-02](../tasks/ALIGN02_SEQUENCE_AND_DISPATCH.md) 检查点 03
- 相关：ADR-0013（偏序集与任务包）、ADR-0049（序列先于 mission）、ADR-0050（分解校验）

## 1. 背景

`TaskSequencePartialOrder.getReadyTaskIds()` 已经给出"pending 且前驱全 done"的集合，并按
`(priorityTier, sequenceOrdinal)` 排序；`explainOrder()` 的文字里也写着
"高优先任务被低层必要前驱阻塞时，该前驱可先行" —— **但没有任何代码实现这个选择**，
任务包（`TaskBundleRecord`）也从未作为"派发单位"被挑选过。

本检查点补上"选哪些单元"的契约，不改派发（`SecondaryContinuousDispatchLoop` 仍是
`dispatchChain: async () => false`，属 02-05）。

## 2. 契约（冻结）

1. **候选只来自 ready set**：`pending` 且**全部直接前驱 `done`**。
   任何未满足依赖的任务**永远不会**进入结果 —— 置顶、提权、包内顺序都不能绕过。
2. **有效优先级**：`effectivePriorityTier(t) = min(自身 tier, 所有可达后继的 tier)`。
   即"高优先任务所必需的前驱"随其后继一起提升，但**只对已就绪的前驱生效**；
   这是排序，不是放行。
3. **任务包是不可拆单位**：`prepared` 包整体参与；包内任一任务非 `pending`、
   或首任务未就绪 ⇒ **整包推迟**（不拆包、不跳节点），并给出具体原因
   （未完成前驱 / 非 pending / 空包）。
4. **预算按单元计**：`maximumUnitCount` 限制本次任务组引用的单元数（包 = 1 个单元，
   包内任务数不变）；装不下的单元**整体推迟**，不截断包。
5. **确定性排序**：`(有效优先级, 最小 sequenceOrdinal, 单元标识)` 三级比较，同输入同输出。
6. **只读**：选择不改 revision、不改状态；同一序列可被反复选择而结果稳定。

## 3. 生产调用链（源码位置）

```
调用方（CLI/SDK/后续调度）
└─ TaskSequenceStatusController.selectNextTaskGroup                 packages/core/src/orchestration/task-sequence-controllers.ts
   ├─ 鉴权：用户或序列 owner（与 getSnapshot 同口径）
   ├─ AgentTaskSequenceStore.readSequence                          （只读）
   └─ selectReadyTaskUnits({nodes, bundles, maximumUnitCount})      ready-task-group-selection.ts
      → { units, deferredUnits, readyTaskIdentifiers,
          effectivePriorityTierByTaskIdentifier, deferredReasons }
```

## 4. 未完成（如实）

- **没有派发消费者**：`SecondaryContinuousDispatchLoop.dispatchChain` 仍恒 `false`、
  占用数仍恒 `0`（02-05）；本检查点只交付"选哪些"，没有"派出去"。
- **未接执行者容量**：选择不看可用槽位、绑定个体是否存活、并发租约；
  `maximumUnitCount` 由调用方给定，没有与并发配置联动。
- **任务包没有生产创建方**：`createTaskBundle` 仍无生产调用者（同 01-04 的直投困境）。
- **没有端到端验证**：未构造 DAG + 包 + 阻塞场景实测"必要前驱提升"与"整包推迟"。
- **`explainOrder` 与新选择的措辞尚未统一**：前者说"可先行"，后者用有效优先级排序；
  两者口径一致但表述分散，后续可合并。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
