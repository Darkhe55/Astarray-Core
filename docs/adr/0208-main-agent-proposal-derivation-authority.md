# ADR-0208 主 Agent 对派生次级序列的提案管理权（ALIGN-01-03 成功路径）

## 1. 背景

ALIGN-01-03 的"成功提交"长期缺失。审计发现这是一个**规则组合矛盾**，不是缺一根接线：

1. `MainAgentTaskProposalContract` 明确禁止主 Agent 把提案投给自己（`targetSecondaryAgentInstanceIdentifier === sourceActorIdentifier` ⇒ 拒绝）；
2. `TaskSequenceManageController.assertActorAllowedToManage` 只允许**用户**或**序列所有者本人**管理；
3. 于是：目标只能是次级，而主 Agent 又不是次级的所有者 ⇒ **不存在可成功的组合**。
   已有测试只覆盖了"被拒绝（无权管理序列）"，把矛盾当成了预期行为。

## 2. 决策

允许"**创建者**"管理被创建者的序列，且创建关系只能由**宿主登记**：

- `registerAgentIdentity` 新增可选 `createdByAgentInstanceId`（模型不可填）；
- 运行时维护 `owner → creator` 同步表，并注入 `TaskSequenceManageController.resolveCreatorOf`；
- `assertActorAllowedToManage`：用户 → 放行；所有者本人 → 放行；**创建者 === 操作者** → 放行；其余照旧拒绝；
- 未登记创建关系时行为完全不变（缺省不推断、不按项目/角色猜）。

## 3. 反例与边界

- 非创建者的主 Agent 仍被拒绝（`task-sequence-permission-denied`）；
- 创建关系不持久化到磁盘（当前只在运行时内有效）：进程重启后需宿主重新登记；
- 该权力只覆盖"序列层管理"，不绕过提案契约、优先级策略（agent 不得进层级 0）、
  完成门禁与权限组；
- 没有放宽"用户/所有者"旧规则，也没有让模型声明来源。

## 4. 验证

- 新增 `tests/core/integration/align01-03-proposal-success.test.ts`：
  ① 派生次级序列接受提案并按锚点插入（首任务 + 派生任务两节点）；
  ② 非创建者仍被拒绝；
- 公开库全量 `check:low-parallel` → **600 files / 4198 tests** 通过，typecheck/lint/build 绿。

## 5. 遗留

- 创建关系持久化（重启后仍可管理）未做；
- GUI/CLI 没有"登记派生关系"的用户入口（属宿主装配职责）。

## 6. 追加（2026-11-04）：派生关系持久化

- 原实现只在运行时 `Map` 里记 owner→creator，**重启即丢**；
- 现在 `registerAgentIdentity(createdByAgentInstanceId)` 同时写入
  `AgentCreationRegistry`（`<state>/agent-creation-registry.json`），运行时启动时预加载；
- 落盘失败不阻塞身份登记，但如实降级（下次启动失去该派生关系）；
- 验证：`align01-03-persisted-derivation.test.ts`（登记 → 等待落盘 → 关停 → 新运行时 → 仍可提交）；
  公开全量 **601 files / 4200 tests** 通过。
