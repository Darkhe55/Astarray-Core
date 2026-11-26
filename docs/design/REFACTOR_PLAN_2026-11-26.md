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
| **P2** | `public-sdk` 按 FR 拆子门面 | **进行中（五域 + 只读 getter + CLI 起步接入）** | 5 个 facet、23 个方法、31 条单测；`facade.goal/permission/ops/context/mission` |
| **P3** | 权限判定迁出 `PermissionResolutionService` | **进行中**（纯判定 + 概览装配已抽出） | `permission-resolution.ts` + `permission-overview.ts` + 11 条反例 |
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

## P2：`public-sdk` 按 FR 拆子门面（进行中）

**子门面入口与 CLI 窄依赖（第七切片）**：
- 门面新增只读 getter：`facade.permission/ops/goal/context/mission`（首次访问构造并缓存）；
- `goal-mode-command.ts` 的 5 处调用改走 `application.goal.*`（提案/确认/绑定/需求映射/证据失效），
  验证"CLI 只依赖所需子门面"；`recomputeGoalPotential` 尚不在 goal facet，暂留门面；
- 单测 3 条：getter 缓存同一实例、窄方法面不含整门面方法、关闭态拒绝。



**mission 只读域（第六切片）**：
- 新文件 `public-sdk-facets/mission-facet.ts`：`queryMissionStatus`、`queryMissionTaskSequence`、
  `queryMission`、`queryMissionRawStatus`；
- 兼容性细节：`queryMissionStatus` 原实现**不校验关闭态**，迁出后同样不校验（其余三个保留 `assertOpen`）；
- 单测 5 条：透传且不触发 assertOpen、序列先校验、状态映射、原始状态缺省 running、关闭态不触达；
- mission 写路径（submit/cancel/resume）仍留门面，待 P2 后续切片单独处理。



**上下文预算域（第五切片）**：
- 新文件 `public-sdk-facets/context-facet.ts`：`queryContextSettings`、`updateContextBudget`；
- 宿主窄接口：预算策略读写、装配事件读取、领域错误转换、`budget-policy-updated` 事件发射；
- 单测 5 条：生效值与样本数、无事件为 null、CAS 写入后重读并发事件、领域错误转换且不发事件、关闭态不触达存储；
- `PublicContextSettings` 定义迁到 facet 并在门面再导出（对外导出不变）。



**目标域（第四切片）**：
- 新文件 `public-sdk-facets/goal-facet.ts`：12 个目标模式方法（激活/提案/确认/创建/绑定/解绑/状态/停用/关闭实验/需求映射/证据失效）；
- 宿主窄接口 `goalService`（结构上与 runtime 目标服务一致）；门面保留同名委托；
- 单测 5 条：同步/异步委托、参数原样透传、未定义语义保留、关闭态不触达服务；
- 说明：这些方法原本就是"逐字委托 runtime"，迁出后**逻辑位置**解耦（门面不再持有目标域语义），
  但 `public-sdk.ts` 行数下降有限（签名仍需保留），符合计划中"先切依赖面、再迁大块实现"的顺序。



**运维只读域（第三切片）**：
- 新文件 `public-sdk-facets/ops-facet.ts`：`queryStartupRecoveryState`、`queryExperimentCatalog`、
  `queryArtifacts`、`queryMissionArtifacts`；
- 宿主窄接口：启动恢复策略/报告、实验设置、成果记录、任务链查询；
- 单测 5 条：原样透传、enabled/canEnable 映射、三种过滤、无任务链返回空、关闭态不触达读取；
- `public-sdk.ts` 再瘦身（移除不再使用的 `StartupRecoveryBootReport`/`EXPERIMENT_CATALOG` 导入）。



**已完成（权限域两次切片）**：
- 新文件 `public-sdk-facets/permission-facet.ts`：`listPermissionToolOverview`、`previewToolPermission`、
  `queryPermissionToolOverview`、`queryParameterAuthorizationRuleDetails`；
- 宿主为**窄接口**（controller 两个查询入口 + 参数授权设置存储 + `assertOpen`），子门面不依赖门面其余状态；
- 门面保留同名方法并委托（导出面不变）；`public-sdk.ts` 8540 → 8525 行；
- 第二批：`previewParameterAuthorization`、`queryParameterAuthorizationSettings`、`updateParameterAuthorizationSettings`、
  `updateParameterAuthorizationRules` 也迁入（含非法 JSON/未知工具/权限组不可读、总开关关闭、revision 冲突、
  放宽需确认、写入被拒抛宿主错误）；单测累计 8 条；`gui03` 回归通过。
- 错误构造改为宿主注入，避免子门面 -> 门面的循环依赖。



- 现状：`public-sdk.ts` 8540 行、fan-in 128、单类覆盖全部 FR（矩阵 FR8 行 8 个 X）。
- 做法（渐进、不破坏导出）：
  1. 先按 FR 把方法分组到 **mixin/委托对象**（`MissionApi`、`PermissionApi`、`GoalApi`、`ContextApi`、`OpsApi`），`AstarrayApplicationFacade` 保留同名方法转发；
  2. 再让 CLI 直接依赖对应子门面（减少对大一统门面的 fan-in）；
  3. 最后视情况把子门面拆文件（`public-sdk/` 目录 + barrel 导出）。
- 验收：`public-sdk` 导出面不变；CLI 编译通过；新增"子门面可独立实例化/调用"的单测；fan-in 统计下降。

## P3：`PermissionResolutionService`（进行中）

**第一切片：纯判定抽出（已完成）**
- 新文件 `orchestration/permission-resolution.ts`：`resolveToolBaselineDecision(profile, capabilityIds, toolName)`；
- 此前 `listPermissionToolOverview` 的 `strictest` 与 `computeCapabilityBaseline` 是**同一规则的两份实现**，
  现都改为调用纯函数；`main-controller` 只负责读 profile；
- 反例 6 条：无权限组 null、无能力映射显式/null、能力 deny 胜出、ask 聚合与显式覆盖、
  fallback 缺省、显式 deny 覆盖聚合；
- 保留规则语义：**能力级 deny 先于显式工具决定**（与旧实现逐字一致）。

**第二切片：概览装配抽出（已完成）**
- 新文件 `orchestration/permission-overview.ts`：`buildPermissionToolOverview({profile, capabilityCatalog, registry})`；
- 控制器只读 profile 后调用；能力目录缺失 ⇒ 空数组（不伪造）；未注册工具如实 `isExecutable=false`；
- 反例 5 条：缺目录空数组、并集排序与纯动作标记、无 profile 来源 unknown、最严聚合、
  目录已映射未注册两字段都 false。

**下一步（第三切片）**：引入 `PermissionResolutionService` 类，把 profile 读取 + 概览 + 预览 + 判定
组装为一个可注入服务，控制器只保留一个端口字段。



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
| `public-sdk.ts` 行数 | 8540 | 8252 | 拆分后单文件 < 3000 |
| 分支覆盖率 | 83.05% | 83.13%（P1 后实测） | ≥ 83.05% |
