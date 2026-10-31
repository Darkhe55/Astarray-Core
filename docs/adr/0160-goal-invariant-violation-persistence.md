# ADR-0160 安全不变量违规持久化（R97，2026-11-01）

- 状态：已采纳（状态 + hydrate 恢复 + 单测；真实重启未演练）
- 来源：用户"继续推进任务卡"；ADR-0143 遗留"违规不持久化"
- 相关：ADR-0143（K4）、ADR-0150（状态合并）

## 1. 问题

`recordInvariantViolation` 只写内存门禁：**进程重启后违规消失**，
"进展不得抵消越权"在重启后会被绕过。

## 2. 设计

1. 目标状态新增可选 `invariantViolations[]`（`invariantCode`/`detail`/`recordedAtIso`）。
2. 运行时 `onGoalInvariantViolation`：内存记录 + **异步写状态**（按 mission 绑定找到目标；
   写失败不阻塞工具执行）。
3. `GoalGateCache.hydrate` 还原门禁后调用 `gate.restoreInvariantViolations(state.invariantViolations ?? [])`：
   - 只接受**契约已声明**的标识（未声明忽略）；
   - 重复恢复幂等（同 code+detail+时间不重复追加）。
4. 违规仍**独立于 V**（不因 V 下降清除）。

## 3. 验证

```
tests/core/goal-invariant-violation.test.ts → 5/5
  新增：恢复只接受已声明标识；恢复后派发被拒。
tests/core --maxWorkers=2 → 471 files / 3595 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- **真实重启未演练**：没有"记录违规 → 重启 → 派发被拒"的端到端证据；
- 写状态是 **fire-and-forget**：进程在写入前崩溃则丢一条（工具执行不被阻塞是刻意取舍）；
- 违规列表**无上限**（长跑目标可能持续增长，后续需截断/归档）。
