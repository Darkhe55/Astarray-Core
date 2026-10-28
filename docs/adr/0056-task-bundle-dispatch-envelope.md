# ADR-0056 任务包派发信包：权限求交、边界与工具说明引用（ALIGN-03-02）

- 状态：部分采纳（信包构造 + 持久化；执行侧未消费）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 02
- 相关：ADR-0051（单元选择）、ADR-0045（提案边界）、G4 工具说明协议

## 1. 背景

卡内要求：持续调度的任务包携带**工具权限上限、项目边界、原始要求、完成条件、
选择性附件**；子权限与上级有效权限**求交**；工具说明**复用既有协议**，
不能每次重发完整工具库，也不能在缺用法时让模型猜。

实测：`TaskBundleRecord` 只有 `bundleId/boundAgentInstanceId/sequenceRevision/taskIds/status`
—— **六项全无**；`createTaskBundle` 不接收权限上限或边界；工具说明协议
（`ToolDocumentationRecallInjector`：initial-full / subsequent-reminder / delta）已存在且实现完整，
但任务包与它之间没有引用关系。

## 2. 契约（冻结）

1. **六项必填**（工具权限上限、项目边界、原始要求、完成条件、工具说明引用；
   附件可为空但必须是**显式选择**）：缺一即 `task-bundle-invalid`。
2. **只求交、不放大**：`allowedToolNames = 请求 ∩ 上级有效权限`；
   超出上级的申请项进入 `deniedToolNames` **如实上报**，**绝不**进入执行；
   求交后为空 ⇒ 拒绝发信包（不允许"空权限也能派"）。
3. **不得重发工具库**：出现 `toolDescriptors`/`availableTools`/`toolLibrary`/
   `fullDocumentation`/`toolSchemas` 任一字段 ⇒ 拒绝；信包只带
   `toolDocumentationReference { toolGroupIdentifier, toolGroupRevision }`，
   由既有注入器按 revision 决定全量/提醒/差异。
4. **原始要求不可编造**：`userTaskReference` 由 harness 注入（与提案/插入同一口径）。
5. **完成条件**：`acceptanceCriteria` 非空；`requiredArtifactIdentifiers` 为声明，
   **不证明**产物已产出（完成门禁仍然独立）。
6. **附件是选择而非整段上下文**：每条附件必须带 `attachmentIdentifier` + `contentHash`。
7. **持久化**：信包随 `TaskBundleRecord.dispatchEnvelope` 落盘（schema 校验）；
   旧包没有该字段 ⇒ 按"旧格式、无信包"处理，**不得补默认权限**。

## 3. 生产调用链（源码位置）

```
构造（本地）
└─ buildTaskBundleDispatchEnvelope({ payload, parentEffectiveToolNames })
   packages/core/src/orchestration/task-bundle-dispatch-envelope.ts
   ├─ 严格白名单 + 禁止工具库字段
   ├─ intersectToolPermissionCeiling（allowed / denied）
   └─ 六项校验 → TaskBundleDispatchEnvelope
持久化
└─ TaskSequenceManageController.createTaskBundle({ …, dispatchEnvelope })
   └─ TaskBundlePlanner.createBundle → AgentTaskSequenceStore（taskBundleRecordSchema 校验）
读取
└─ TaskSequenceStatusController.getSnapshot().bundles（含 dispatchEnvelope）
```

## 4. 未完成（如实）

- **执行侧未消费**：orchestrator/worker 派发时**不读** `dispatchEnvelope`，
  仍然用现有工具端口与提示词装配；"任务包携带"目前停在数据层与读取视图。
- **`createTaskBundle` 仍无生产调用方**（与 01-04 直投、02-03 选择同源困境）。
- **`deniedToolNames` 只上报不升级**：申请被削时没有通知用户/上级的策略；
  也没有"连续被削"的告警。
- **工具说明协议未改动**：本卡只在信包里**引用** revision，未验证"注入器真的按信包工作"。
- **未验证**：没有跑过求交（削权）、禁止工具库字段、六项缺失、附件哈希校验任何一条路径。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
