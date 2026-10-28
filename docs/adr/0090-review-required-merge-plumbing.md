# ADR-0090 让"合并前要求审查者"从产品装配可达（收尾第 5 步）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[DEFAULT_SWITCHES_AUDIT_2026-10-29](../reports/DEFAULT_SWITCHES_AUDIT_2026-10-29.md) 缺口 ②
- 相关：ADR-0079（完成门禁）、`GitIntegrationCoordinator`

## 1. 背景

`isReviewRequiredForMerge` 只存在于 `GitIntegrationCoordinatorOptions`；
`application-runtime` 构造协调器时**没有传该字段**，也没有对应的运行时选项。
后果：代码里"合并前要求已指定审查者"的检查**永远不生效**，且**无法从产品装配打开**。

## 2. 变更（最小）

1. `ApplicationRuntimeOptions.gitIntegration` 增加 `isReviewRequiredForMerge?: boolean`；
2. 构造 `GitIntegrationCoordinator` 时按 `=== true` 透传（缺省**不传**，行为逐字不变）；
3. **不改**协调器的默认值（仍 false）、**不改**任何既有检查语义。

## 3. 生产调用链（源码位置）

```
ApplicationRuntimeOptions.gitIntegration.isReviewRequiredForMerge   packages/core/src/application/application-runtime.ts
└─ new GitIntegrationCoordinator({ ..., isReviewRequiredForMerge? })
   └─ finalizeIntegration → requiresReviewer: options.isReviewRequiredForMerge === true
      └─ 未指定审查者 ⇒ 拒绝合并（既有逻辑，未改）
```

## 4. 未完成（如实）

- **默认仍关**：本次只让开关"可达"，**没有**改变默认行为；产品是否开启需用户决定。
- **没有运行验证**：没有跑过"开关关 ⇒ 允许无审查者合并""开关开 ⇒ 拒绝"任何一条。
- **同批硬编码仍未处理**：运行时构造协调器时
  `allowedPathsByTaskType: {}` 与 `integrationTestCommands: []` 仍是**写死的空值**，
  意味着"按任务类型的允许路径"和"集成测试命令"在产品装配里同样**不可配置** ——
  这是下一个同源缺口，本次**未改**（属独立检查点）。
- **审查者注册目录未接**：`reviewingAgentInstanceIdentifier` 的登记校验依赖
  `registeredAgentDirectory`，运行时是否注入未在本轮核实。
