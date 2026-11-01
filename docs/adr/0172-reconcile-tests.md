# ADR-0172 对账入口的自动化测试（R111，2026-11-01）

- 状态：已采纳（3 条单测；补上 ADR-0171 的测试缺口）
- 来源：用户"继续任务"；ADR-0171 遗留"对账命令无自动化测试"
- 相关：ADR-0170（组对账）、ADR-0171（任务对账/续接修复）

## 1. 覆盖

`tests/core/goal-reconcile.test.ts`（3/3）：

1. **任务对账**：`running ⇒ pending`、其余任务不变、`revision+1`、返回 `previousStatus`；
2. **拒绝路径**：已完成任务不能"对账"；空说明被拒（防止盲放行）；
3. **目标组对账**：清空 `currentTaskGroupIdentifier`、把组 id 写入证据缺口。

测试通过公开门面（`AstarrayApplicationFacade`，mock 运行时）驱动，与 CLI 走同一路径。

## 2. 验证

```
tests/core/goal-reconcile.test.ts → 3/3
tests/core --maxWorkers=2 → 471 files / 3604 tests 全通过
typecheck / lint / build → 全绿
```

## 3. 未完成

- 仍无"CLI 端到端"测试（本次覆盖门面层，未覆盖 commander 参数解析）；
- 没有"对账后 resume 成功"的自动化集成测试（真实演练见 ADR-0171）；
- 租约过期等待（30s）未写进测试（避免慢测试）。
