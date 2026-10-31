# ADR-0158 墙钟预算评估（R95，2026-11-01）

- 状态：已采纳（暂停条件覆盖墙钟；派发前门禁仍未按墙钟阻断）
- 来源：用户"继续推进任务卡"；K6 遗留"`maximumWallClockSeconds` 未评估"
- 相关：ADR-0141（暂停条件）、ADR-0119（组边界）

## 1. 问题

`pauseConditions` 已收窄为枚举，但 `maximumWallClockSeconds` **没有被任何代码读取**：
状态里也没有"目标开始时间"，所以墙钟预算写了等于没写。

## 2. 设计

1. 状态新增**可选** `goalStartedAtIso`：
   - `createGoalContract` 初始化时写入；
   - 旧状态缺该字段 ⇒ **不猜**（不评估墙钟）。
2. `evaluateGoalPauseConditions` 在声明 `budget-exhausted`、契约有 `maximumWallClockSeconds`、
   且状态有开始时间时，按 `now - started >= 上限` 触发暂停，原因写明"已用 N 秒 / 上限 M 秒"。
3. 组结束路径已有的评估调用无需改动（自动覆盖新分支）。

## 3. 验证

```
tests/core/goal-pause-conditions.test.ts  → 10/10
  新增：超限触发 budget-exhausted；无开始时间 ⇒ 不评估
tests/core --maxWorkers=2 → 471 files / 3593 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未做

- **派发前门禁不按墙钟阻断**：`assertDispatchAllowed` 仍只看绝对 `deadlineIso`
  （墙钟是相对量，门禁目前没有开始时间输入）；
- 无集成测试（真实 mission 跑到超时再暂停未演练）；
- `goalStartedAtIso` 在契约变更（K3）时保留旧值（累计预算不重置的语义），未单独校验。
