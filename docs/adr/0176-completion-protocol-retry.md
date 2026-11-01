# ADR-0176 完成控制协议缺失的有界重试（R115，2026-11-01）

- 状态：**已实现并真实跑通**（缺事件 → 重试 1 次 → mission done）
- 来源：用户"继续"（卡内"模型不守约"可用性问题）
- 相关：ADR-0164（完成事件核查）、ADR-0170（早停续跑）、ADR-0149（治理停止）

## 1. 问题

真实 Provider 偶尔不在末行输出 `ASTARRAY_TASK_COMPLETION_V1`（模型不守约），
完成门禁按设计拒绝结案 ⇒ 任务"明明做完了却失败"，用户只能整单重提。

## 2. 设计（有界、不叠加）

`shouldRetryCompletionProtocolFailure`（纯函数）：

- 仅当 **要求完成事件**（provider 路径）+ 失败原因含"缺少 ASTARRAY_TASK_COMPLETION_V1/完成控制事件"
  + 本任务协议重试次数 **< 1** 时 ⇒ 重试；
- **已通过早停续跑/权限重跑重试过**（`resumeAttemptsByTask > 0`）⇒ **不再叠加**，
  保证总尝试次数仍有界（G5 用例实测：叠加会把 3 次变 4 次，破坏既有契约）；
- 重试走 reassign 语义：`releaseTaskBackToPending` + 标记返工（组性质 `rework`）+ 升级说明。

## 3. 真实证据

```
run … --model-planning（两节点读取任务）
astarray: [需要用户] 缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）
astarray: [需要用户] 缺少完成控制事件：有界重试（第 1/1 次）
→ {"missionId":"mission-9d01d418","status":"done"}
task-chain: T-01 done、T-02 done
```

即：**第一次缺事件 → 自动重试一次 → 正常完成**（修复前会直接失败收口）。

## 4. 验证

```
tests/core/goal-completion-protocol-retry.test.ts → 4/4（含"不叠加早停续跑"）
tests/core --maxWorkers=2 → 471 files / 3612 tests 全通过（首轮两条瞬时失败，重跑 exit 0）
typecheck / lint / build → 全绿
```

## 5. 未完成

- 重试**不修改提示词**（只是重跑同一任务；模型可能再次不守约，重试一次后仍失败）；
- 重试会把任务标记为返工（组性质 rework），但**不改变停滞判定语义**（返工组不计停滞）；
- `completionProtocolRetriesByTask` 只在内存（进程重启后归零，可能多给一次机会）；
- 真实证据只到"重试后完成"，未造"重试后仍失败"的实跑。
