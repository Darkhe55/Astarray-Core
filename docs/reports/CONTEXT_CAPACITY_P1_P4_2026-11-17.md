# 上下文容量与准入 P1–P4 实施记录（2026-11-17）

## 已完成

### P1 总预算规划

- 新增 `context-capacity-planner.ts`。
- Provider 输入空间先扣除系统规则、当前任务、工具说明、协议和输出预留，再计算可注入历史预算。
- `resolveContextBudget` 增加 `reservedInputTokens`。
- `ApplicationRuntime` 增加 `contextReservedInputTokens` 和 `contextPromptTokenLimit` 可选入口。

### P2 预算不足 fail-closed

- 全局决策最高优先级无法装入时抛出 `context-budget-insufficient`。
- 未选中的全局决策通过 `deferredContextWriter` 写入按 Agent/mission 隔离的延后上下文。
- 预算配置为 0 时保持原语义：不注入任何全局记录，也不阻塞。

### P3 提示词级硬预算

- `assembleContextPrompt` 增加 `maximumPromptTokenCount` 和可注入 token 计数器。
- global records、局部前沿、context packs、回访块和协调消息全部计入最终提示词预算。
- 超限时不静默截断，抛出 `context-budget-insufficient`。

### P4 阶段策略

- 新增 `context-phase-policy.ts`。
- 支持 `planning`、`execution`、`verification`、`recall` 四阶段。
- 阶段比例只调整历史/提示词注入预算；系统规则、任务和输出预留仍由 P1 先扣除。
- 选择缓存键包含阶段，阶段变化会使全局选择缓存失效。

## 验证

```text
npm run typecheck   通过
npm run lint        通过
目标上下文测试      5 文件 / 20 用例通过
```

测试使用 `threads` 池；当前沙箱禁止 Vitest fork 子进程，故未运行完整测试套件。

## 提交

```text
2d58758e feat: plan context capacity and block on budget insufficiency
20b8d043 feat: enforce prompt-wide context budget
dc80c6c1 feat: apply phase-aware context budgets
```

## 待办

- P5：provider context overflow 分类与单次降级重试。
- P6：optional 候选可插拔评分器。
- 完整核心测试套件与发布检查。
