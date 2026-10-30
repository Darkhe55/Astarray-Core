# ADR-0131 组性质解析抽成纯函数 + 单测（R62，2026-10-30）

- 状态：已采纳（策略可单测；**首次有针对性单测通过**）
- 来源：用户授权选项 A；[ADR-0130](0130-group-kind-default-policy.md)（策略定义）
- 相关：ADR-0126（接入点）、ADR-0122（V）

## 1. 背景

R61 的默认策略写在 `MissionOrchestrator.runLoop` 内联分支里：要验证它必须构造完整编排器
（调度器、租约、反馈通道…），成本高，实际结果就是**没有任何针对性验证**。

## 2. 变更（冻结）

1. 抽出纯函数 `packages/core/src/orchestration/goal-task-group-kind.ts`：

```ts
resolveGoalTaskGroupKind({
  taskIdentifiers,            // 本次要启动的任务
  reworkedTaskIdentifiers,    // retry / reassign / 早停续跑 写入的集合
  provider?,                  // 宿主覆盖（可选）
}) => GoalGroupKind
```

规则不变：provider 优先 → 抛错回退 `normal` → 否则任一任务在返工集合 ⇒ `rework` → 否则 `normal`；
**永不产生 `investigation`**。

2. `runLoop` 改为调用该纯函数（行为与 R61 相同，**没有新增语义**）。
3. 新增单测 `tests/core/goal-task-group-kind.test.ts`（6 个用例）：
   - 无返工 ⇒ `normal`；任一返工 ⇒ `rework`；
   - provider 覆盖返工事实 ⇒ 用 provider 值；
   - provider 抛错 ⇒ `normal`；
   - 默认策略不产生 `investigation`；
   - 传给 provider 的是**副本**（外部改动不影响判定）。

## 3. 运行结果（真实）

```
npx vitest run tests/core/goal-task-group-kind.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

另外：`typecheck` exit 0、`eslint <改动文件>` exit 0、`npm run build` 成功。

## 4. 这些结果能说明什么 / 不能说明什么

**能**：默认解析规则本身（provider 优先级、抛错回退、返工命中、副本语义）按预期工作。

**不能**：
- 不能说明**编排器把它用在正确时机**（组开始）——那需要真实调度循环；
- 不能说明 **retry/reassign/早停续跑** 真的写入了 `reworkedTaskIdentifiers`（集成路径未测）；
- 不能说明"停滞检查因此正确"——V 与 pause 行为未测；
- **全量测试套件仍未运行**（只跑了这一个文件）。

## 5. 验证状态

- **本文件覆盖的规则**：已运行并通过（6/6）；
- **其余路径**：`implemented-unverified`；
- `npm run test`（全量）**未运行**。
