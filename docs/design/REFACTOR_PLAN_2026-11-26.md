# 全面解耦改造计划（AXIOMATIC-DESIGN 落地）

> 依据：[`AXIOMATIC_DESIGN_MATRIX_2026-11-26.md`](./AXIOMATIC_DESIGN_MATRIX_2026-11-26.md)
> 目标：把设计矩阵中 **FR1/FR3/FR4/FR5/FR8 的交叉耦合**逐步改为"底层不耦合 + 上层有序三角"。
> 约束（每阶段都必须满足）：
> 1. **行为兼容**：公共 SDK/CLI 签名与语义不变；先写反例测试再改；
> 2. **门禁全绿**：`typecheck`、`lint`、`npm test`、`test:scripts`、隐私检查；
> 3. **覆盖率不下降**：基线分支 **83.05%**（2026-11-26）；
> 4. **文档同步 + 提交推送**：每阶段更新本文件与 `PLAN_STATUS.md`。

## 阶段总览

| 阶段 | 内容 | 状态 | 主要产出 |
|---|---|---|---|
| **P1** | 完成判定三角化（`CompletionDecision` 聚合器） | **done（2026-11-26）** | `mission-completion-decision.ts`（134 行）+ 7 条反例；`main-controller` 该段 −53 行 |
| **P2** | `public-sdk` 按 FR 拆子门面 | 未开始 | `Mission/Permission/Goal/Context/Ops` 子门面 + CLI 只依赖所需子门面 |
| **P3** | 权限判定迁出 `PermissionResolutionService` | 未开始 | 从 `main-controller` 抽出组合判定与 `previewToolPermission` |
| **P4** | 目标门禁适配器 `GoalDispatchGateAdapter` | 未开始 | 封装 `goal-gate-cache` + 契约/状态读取 |
| **P5** | 矩阵治理 + `createApplicationRuntime` 选项分组 | 未开始 | `docs/design/DESIGN_MATRIX.md`、import 规则、子配置对象 |

## P1：完成判定三角化（已完成）

**问题**：`projectMissionCompletionGate` 在 `main-controller` 内同时读任务链、收据、独立裁决，与租约/目标门禁同处一个 6000+ 行大类 ⇒ FR1/3/4/5 交叉。

**改造**：新增纯编排模块 `mission-completion-decision.ts`，端口注入、固定顺序：

```text
task-chain → receipts → independent-verdict
```

**契约要点**：
- 严格模式关闭 ⇒ 后两步 `skipped`（不伪造通过）；
- 任务链**读取失败上抛**（不得当成"全 done"）；
- 收据/裁决端口抛错 ⇒ 该步不通过（fail-closed）；
- 原因文本与旧实现一致（兼容既有调用方）。

**证据**：`tests/core/unit/mission-completion-decision.test.ts` 7 条；`coordination-completion-gate` + `wiring04-chain-real-stores` 22 条回归通过。

**指标**：`main-controller.ts` 6183 → 6160 行；该段 −53 行；新模块 134 行、无跨 FR import（只依赖 `completion-receipt.ts` 纯判定）。

## P2：`public-sdk` 按 FR 拆子门面（计划）

- 现状：`public-sdk.ts` 8540 行、fan-in 128、单类覆盖全部 FR（矩阵 FR8 行 8 个 X）。
- 做法（渐进、不破坏导出）：
  1. 先按 FR 把方法分组到 **mixin/委托对象**（`MissionApi`、`PermissionApi`、`GoalApi`、`ContextApi`、`OpsApi`），`AstarrayApplicationFacade` 保留同名方法转发；
  2. 再让 CLI 直接依赖对应子门面（减少对大一统门面的 fan-in）；
  3. 最后视情况把子门面拆文件（`public-sdk/` 目录 + barrel 导出）。
- 验收：`public-sdk` 导出面不变；CLI 编译通过；新增"子门面可独立实例化/调用"的单测；fan-in 统计下降。

## P3：`PermissionResolutionService`（计划）

- 从 `main-controller` 抽出：`previewToolPermission`、能力级 deny 优先、显式工具决定、fallback 组合。
- 端口：`readCurrentPermissionProfile`、`readCapabilityCatalog`。
- 验收：权限矩阵单测（deny 优先/能力组合/参数规则）在服务层独立运行；`main-controller` 仅注入端口。

## P4：`GoalDispatchGateAdapter`（计划）

- 封装 `goal-gate-cache` + 契约/状态读取 + 强制/观察开关，向 `main-controller` 暴露 `assertMissionDispatchAllowed`。
- 验收：目标门禁的"只观察/强制阻断"两分支单测独立；`main-controller` 不再直接拼 goal 逻辑。

## P5：矩阵治理与选项分组（计划）

- `docs/design/DESIGN_MATRIX.md`：FR→DP 表格 + 变更流程（改矩阵行必须附测试）。
- ESLint `import/no-restricted-paths`：禁止 `tools/*` → `orchestration/*` 反向依赖等。
- `createApplicationRuntime` 选项按 FR 分组为 `mission/permission/goal/ops` 子对象（保留旧平铺字段兼容）。

## 指标跟踪

| 指标 | 改造前 | 当前（P1 后） | 目标 |
|---|---|---|---|
| `main-controller.ts` 行数 | 6183 | 6160 | < 4500 |
| `main-controller.ts` import 数 | 107 | 107（P1 未减） | < 70 |
| `application-runtime.ts` 行数 | 5734 | 5734 | < 4500 |
| `public-sdk.ts` 行数 | 8540 | 8540 | 拆分后单文件 < 3000 |
| 分支覆盖率 | 83.05% | 待测 | ≥ 83.05% |
