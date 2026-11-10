# STARTUP-RECOVERY：已验证核心检查点归档

归档日期：2026-11-10。源码核对基线：`9d71ed0c`。
性质：限定范围的检查点归档，非整卡关闭、非发布验收。

完整原始设计、用户修订与历史交付记录仍在 [原任务卡](../../STARTUP_RECOVERY_TASK_CARD.md)，不删改原文，不将旧默认策略当作当前配置。

## 已完成且本轮复核的范围

| 检查点 | 实现与证据 |
|---|---|
| 策略与候选扫描 | `startup-recovery-policy.ts` / `startup-recovery-scanner.ts`；策略校验、持久化、动态上限、候选过滤及序列独有项识别 |
| 恢复执行器 | `startup-recovery-runner.ts`；批次/冷却、失败次数持久化、成功清零、明确跳过 sequence-only、时段关闭不调用恢复 |
| 标签与运行时入口 | 真实关系索引/序列扫描；写工具与只读工具标签派生；显式 `runStartupRecovery()` 入口 |
| 启动与公开 facade 接线 | 显式开启后的延迟执行与报告落盘；未开启不触发；facade 选项透传 |

## 本轮验证

使用已有本地依赖执行，未安装依赖或调用付费模型：

```text
npx --no-install vitest run tests/core/unit/startup-recovery-phase1.test.ts tests/core/unit/startup-recovery-runner.test.ts tests/core/integration/startup-recovery-scan.test.ts tests/core/integration/startup-recovery-labels.test.ts tests/core/integration/startup-recovery-boot.test.ts tests/core/integration/startup-recovery-facade.test.ts --maxWorkers=1
```

结果：6 个测试文件通过，23 个用例通过，exit 0。此结果不替代全量 check、安装包、真实模型、多进程竞争或跨平台验收。

## 不归档为完成的范围

1. `sequence-only` 仍明确跳过，未自动派发为 mission；不能声称所有未完成序列均可恢复。
2. 当前策略 `isEnabled` 与运行时自动触发选项默认关闭；本归档不批准改默认值，也不声称默认启动会续跑。
3. 目标标签的完整派生、含写任务恢复前用户可见提示等未在本轮证明；通知标记不等于提示已经呈现。
4. 时段读取失败时当前执行器按开放处理；是否符合休息时段约束需要单独核定，不能由“关闭时跳过”用例推导故障时也安全。
5. 单次恢复调用成功不等于任务业务完成。独立审查及最终完成门禁的缺口不由本检查点关闭。

父卡保留在活动目录继续跟进以上边界；不移入整卡 accepted 目录。
