# ADR-0154 裁决面暴露与权限询问误报修复（R90/R91，2026-11-01）

- 状态：部分完成（两项修复已验证，一项未做，见 §4）
- 来源：用户"全做"（三项遗留）
- 相关：ADR-0148（预算）、ADR-0153（终态解析）

## 1. R90：治理停止不再伪造权限询问

**问题**：`run` 的裁决循环只在"任务 failed"时 `break`；治理停止（mission blocked、没有权限询问）
会继续调用裁决层，`ask === null` ⇒ 返回 `requires-human-resubmission`，输出里就多出一个
**不存在的权限询问**。

**修复**：`permissionAsk === null` 时直接 `break`（failed 仍映射 blocked，但不再空跑裁决）。

**真实复跑**（goal-k10q）：

```
{"missionId":"mission-7a82abaf","status":"blocked"}   ← 无 permissionAsk 字段
summary.json → blocked
```

## 2. R91：独立验收裁决面暴露

运行时新增（直接委托控制器，不复制规则）：
- `appointIndependentReview`（复用 `IndependentReviewGate.appoint`：三身份互斥、直属上级校验）；
- `recordIndependentVerdict`（复用 `recordVerdict`：证据不得全是自报，写入完成裁决存储）。

公开 SDK 同名方法暴露，供 UI/宿主使用。

**未演练**：任命需要**三个已登记 Agent 实例**（执行/测试/验收）+ 四层路由控制面；
当前 `test/` 只有单任务流程，没有这些身份，故真实裁决**没有跑过**。

## 3. R91 之外：模型自主提议**未做**

模型"在对话里自己提议目标"需要：
1. 在工具清单里新增 `proposeGoal` 描述符（模型才敢调用）；
2. 把该工具执行接到 `proposeGoalContract`（只落提案，用户确认后生效）；
3. 在 worker 允许工具集里放行。

本轮只完成了内核 API 与 CLI（`goal-mode propose`），**没有注册工具**——不做半截工具
（避免模型调用到"占位实现"）。下一轮单独做。

## 4. 验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 真实复跑：`blocked` + 无 `permissionAsk` 字段；目标 `isPaused`、`consumedToolCalls: 1`。

## 5. 遗留清单

| 项 | 状态 |
|---|---|
| 治理停止误报权限询问 | ✅ 已修 |
| 独立裁决 API 暴露 | ✅ 已暴露，**未真实演练** |
| 模型自主提议工具 | ❌ 未做（需工具描述符 + 执行接线） |
| accepted 裁决 → V=0 正向链路 | ❌ 未跑（缺三 Agent 身份） |
