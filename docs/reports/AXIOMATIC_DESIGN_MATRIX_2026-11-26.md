# Astarray-Core 公理设计（Axiomatic Design）矩阵分析

> 分析对象：`Astarray-Core`（TypeScript 单体仓库，`packages/core` + `packages/tui` + `native/sandbox-helper`）。
> 方法：Suh 公理设计——功能需求 **FR** → 设计参数 **DP** 的映射矩阵；**独立性公理**（不耦合/解耦/耦合）与**信息公理**（信息含量、成功概率）。
> 结论先行：**底层（存储 / 纯判定 / 策略）满足独立性公理；上层（编排、运行时装配、SDK 门面、CLI）是耦合设计**，且耦合热点与实测的覆盖率缺口、flaky 分布高度重合。

---

## 1. 口径与符号

- **FR**（Functional Requirement）：系统必须"做什么"，与实现无关。
- **DP**（Design Parameter）：选定的"怎么做"，即模块/机制。
- **设计矩阵** `[A]`（m 个 FR × n 个 DP）：`A[i][j] = X` 表示修改/实现 DP_j 会直接影响 FR_i 的满足。
- 独立性公理三型：
  - **不耦合（uncoupled）**：每行仅一个 X（对角）；
  - **解耦（decoupled）**：三角矩阵，可按固定顺序逐项满足（有明确的"先做什么"）；
  - **耦合（coupled）**：非三角，存在环状相互影响，需整体联调。

---

## 2. FR 分解（顶层）

| 编号 | 功能需求 | 验收关注点 |
|---|---|---|
| FR1 | 把用户指令变成受控的 mission/task 执行 | 任务偏序、派发、终态、取消 |
| FR2 | 在长任务中保持上下文不丢失且可回访 | 上下文包、压缩、关闭节点召回 |
| FR3 | 工具/进程访问必须按权限与沙箱执行 | 能力矩阵、参数规则、沙箱档位、失败闭合 |
| FR4 | 多 Agent 协作、请示与独立裁决 | 收件人校验、逐级上报、裁决证据 |
| FR5 | 目标模式下的稳定性（不偏航、可暂停/重规划） | 目标契约、V 值、派发门禁 |
| FR6 | 跨进程/重启后的持久化、租约与恢复 | store、原子写、租约、恢复中心 |
| FR7 | 运行可观测（性能/用量/诊断）且不上传 | 样本、聚合、降级 |
| FR8 | 面向人的界面（CLI/TUI/GUI）只读可查、可操作 | 命令出口、JSON/文本、错误码 |
| FR9 | 模型与 Provider 的可插拔接入 | 运行时注册、凭据、超时 |
| FR10 | 审计、隐私与合规 | 脱敏、回执、日志、外发门禁 |

## 3. DP 分解（与 FR 对应的实现载体）

| 编号 | 设计参数 | 主要载体（证据） |
|---|---|---|
| DP1 | 任务编排与序列控制 | `orchestration/main-controller.ts`、`mission-orchestrator.ts`、`task-sequence-controllers.ts` |
| DP2 | 上下文装配/压缩/回访 | `continuation-context-pack.ts`、`toolkit/lossless-context-manager.ts`、`summarization/*` |
| DP3 | 权限判定与沙箱执行 | `tools/scope-resolution.ts`、`parameter-authorization-settings-store.ts`、`execution/*`（AppContainer / bwrap / broker） |
| DP4 | 协作与裁决通道 | `coordination-*`、`collaboration-request-service.ts`、`decision-*` |
| DP5 | 目标模式（契约/状态/门禁） | `goal-contract*`、`goal-mode-store.ts`、`goal-gate-cache.ts` |
| DP6 | 持久化与恢复 | 55 个 `*-store.ts`、`mission-lease-store.ts`、`recovery-center` |
| DP7 | 观测与诊断 | `perf-event-store.ts`、`diagnostic-*`、`observability-command.ts` |
| DP8 | 界面与命令层 | `tui/src/cli/commands.ts`、`gui/*` |
| DP9 | 模型运行时接入 | `runtime/*`（provider registry、anthropic/openai 适配） |
| DP10 | 审计/隐私/回执 | `check-public-privacy.mjs`、`delivery-receipt.ts`、各 journal |

---

## 4. 设计矩阵（X = 该 DP 影响该 FR）

| FR \ DP | DP1 编排 | DP2 上下文 | DP3 权限/沙箱 | DP4 协作 | DP5 目标 | DP6 持久化 | DP7 观测 | DP8 界面 | DP9 模型 | DP10 审计 | 行型 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **FR1 执行** | X |  | X |  | X | X | X |  |  |  | **耦合**（5） |
| **FR2 上下文** |  | X |  | X |  | X |  |  |  |  | 解耦（3） |
| **FR3 权限** |  |  | X |  |  | X |  | X | X |  | **耦合**（4） |
| **FR4 协作** |  |  | X | X |  | X |  | X |  |  | **耦合**（4） |
| **FR5 目标** | X |  |  | X | X | X |  |  |  |  | **耦合**（4） |
| **FR6 恢复** | X |  |  |  | X | X |  |  |  |  | 解耦（3，顺序固定） |
| **FR7 观测** |  |  |  |  |  | X | X |  |  |  | 解耦（2） |
| **FR8 界面** | X | X | X | X | X | X | X | X |  |  | **耦合**（8，门面全量） |
| **FR9 模型** |  |  | X |  |  |  | X |  | X |  | 解耦（3） |
| **FR10 审计** |  |  |  |  |  | X |  |  |  | X | 解耦（2） |
| **列扇出** | 5 | 2 | 4 | 3 | 4 | 7 | 3 | 3 | 2 | 1 | — |

**读法**：对角型（FR7/FR10）接近不耦合；FR2/FR6/FR9 为解耦；**FR1/FR3/FR4/FR5/FR8 为耦合**，其中 FR8（界面）一行 8 个 X，是最宽的耦合行。

---

## 5. 逐项证据（为什么这样判定）

### 5.1 不耦合/解耦的底层（设计良好）

- **55 个 `*-store.ts`**：每个 store 单一职责（租约、目标契约、推迟队列、映射表…），写入用原子写 + 备份恢复，读损坏按空/拒绝。修改一个 store 不影响其它 FR ⇒ 对角。
- **纯判定函数**：`scope-resolution.ts`（deny 优先/模式矩阵）、`document-view-adapter.ts`、`lossless-context-manager.ts`、`instruction-merge-mapping.ts` 无 I/O、纯确定性 ⇒ 可单独验证（本轮新增用例即证）。
- **解耦机制**：mission 任务 ↔ 序列节点的**显式映射表**（`mission-task-sequence-map-store.ts`）把"两套记账"从隐式推断改为查表，是典型的**解耦设计**。

### 5.2 耦合热点（与实测缺口一致）

| 热点 | 规模 | 耦合表现 |
|---|---|---|
| `main-controller.ts` | **6183 行 / 107 个 import** | 同时承担 FR1 编排、FR5 目标门禁、FR6 租约、FR3 权限判定、FR7 事件；改任一处都可能触碰其余四项 |
| `application-runtime.ts` | **5734 行 / 205 个 import**（fan-in 60） | 装配 + 目标 V 计算 + 完成收据聚合 + 协调端口；是"装配器"同时又是"业务逻辑" |
| `public-sdk.ts` | **8540 行 / 101 个 import**（fan-in 128） | 单一门面覆盖全部 FR ⇒ FR8 行 8 个 X；界面任何需求都落在同一个类上 |
| `cli/commands.ts` | **5334 行** | 直接调用控制器/门面，命令级校验与业务语义混居 ⇒ FR8 与 FR1/3/4/5 反复交叉 |

> 交叉印证：覆盖率未覆盖分支（≈460）**集中在这四个文件**；集成 flaky 也集中在跨这些边界的编排路径 ⇒ "耦合行"同时是"高信息量、低成功率"的行。

### 5.3 完成判定的"隐藏耦合"（需显式化的三角）

"任务判 done"实际同时依赖：完成收据（DP6）、独立裁决（DP4）、目标完成门禁（DP5）、租约归属（DP6/DP1）。这是**交叉耦合**而非有序三角：任一缺失都可能回退状态。建议改为**显式顺序判定**：

```
receipt → verdict → goal gate → lease owner → done
```

即把该行改造成**下三角（decoupled）**，每个前置失败都有独立原因码，而不是散落在 `main-controller` 的多个分支里。

---

## 6. 信息公理评估

信息含量 `I = log2(1/P_success)`；耦合越大、前置条件越多 ⇒ 成功概率越低 ⇒ 信息含量越高。

| 维度 | 观测 | 含义 |
|---|---|---|
| 参数空间 | `createApplicationRuntime` 选项数十项、`main-controller` 选项数十项 | 装配组合爆炸，P_success 低 |
| 错误分支 | 覆盖率跑显示 ≈460 个未覆盖分支，多在耦合热点 | 边界条件未枚举，失败模式多 |
| 测试成本 | 端到端用例需 ~20–40 行夹具（假 Provider/租约/目标契约） | 验证信息量大 |
| 单点收益 | 低耦合模块（store/纯函数）单测 5–10 行即可覆盖 2–5 分支 | 信息含量低，符合公理 |

**结论**：信息公理同样指向"拆分耦合热点"——不是覆盖率问题，而是**设计结构**问题。

---

## 7. 改造建议（按代价从低到高）

1. **显式化完成判定**（1–2 天）：抽出 `CompletionDecision` 聚合器，固定顺序、结构化原因码；`main-controller` 只调用它。→ 把 FR1/3/4/5 的交叉改为三角。
2. **按 FR 拆分门面**（3–5 天）：`public-sdk` 拆为 `MissionFacade / PermissionFacade / GoalFacade / ContextFacade / OpsFacade`；CLI 只依赖所需子门面，降低 FR8 行扇出。
3. **抽出权限解析服务**（2–3 天）：把 `main-controller` 内 `previewToolPermission`/组合判定迁到 `PermissionResolutionService`，main-controller 改为注入端口。
4. **目标门禁适配器**（2 天）：`GoalDispatchGateAdapter` 封装 `goal-gate-cache` + 契约/状态读取；main-controller 不再直接拼 goal 逻辑。
5. **设计矩阵治理**（持续）：`docs/design/DESIGN_MATRIX.md` 维护 FR→DP；用 ESLint `import/no-restricted-paths` 禁止 FR 间交叉 import；CI 在矩阵行变化时要求更新。
6. **信息量收敛**：把 `createApplicationRuntime` 的选项按 FR 分组为子配置对象（`mission`/`permission`/`goal`/`ops`），减少非法组合。

---

## 8. 结论

| 判断 | 结论 |
|---|---|
| 独立性公理（底层） | **满足**：55 个 store + 纯判定函数 + 映射表解耦 |
| 独立性公理（上层） | **不满足**：FR1/3/4/5/8 耦合；`public-sdk` 是最宽耦合行（8/10） |
| 信息公理 | **高信息含量**集中在 4 个文件（6183/5734/8540/5334 行），与覆盖率缺口、flaky 分布一致 |
| 最大单点风险 | `main-controller.ts` 同时耦合 5 个 FR；`public-sdk.ts` 单门面覆盖全部 FR |
| 建议主轴 | 先显式化"完成判定"（三角化），再按 FR 拆分门面与控制器，最后以矩阵 + import 规则治理 |

> 局限：本矩阵基于源码结构、import 统计、卡状态与测试观测得出，是**结构级**判断；未对每个 DP 做形式化耦合度量（如传递闭包分析）。若要更严格，可在 CI 中生成 import 图并计算"FR 分组间耦合度"。

---

## 改造后复核（2026-11-26，P1–P5 阶段成果）

> 数据由 `node scripts/check-decoupling-imports.mjs --json` 实测；纪律：先反例、后实现、每轮全量门禁。

### 结构变化

| 位置 | 改造前 | 改造后 | 说明 |
|---|---|---|---|
| `orchestration/main-controller.ts` | 6183 行 / 107 imports | **6219 行 / 85 imports** | imports 减少 22，权限/完成/门禁逻辑迁出 |
| `public-sdk.ts` | 8540 行 / 101 imports | **8599 行 / 205 imports** | 5 个子门面 + getter + 委托；逻辑迁出、签名保留 |
| 子门面 | 无 | **5 个**（mission/permission/goal/context/ops） | 23 个方法、31 条独立单测 |
| 新服务/适配器 | 无 | **5 个**（完成判定、权限纯判定、权限概览、权限服务、目标门禁适配器） | 28 条反例单测 |

### FR/DP 复核

| FR | 改造前耦合 | 改造后 | 证据 |
|---|---|---|---|
| FR1 完成判定 | 控制器内联 receipt→verdict→goal gate | `decideMissionCompletion` 固定顺序聚合器 | 7 条反例；strict-off 两步 skipped |
| FR3 权限判定 | `strictest` 与 `computeCapabilityBaseline` 两份实现 | `resolveToolBaselineDecision` + `PermissionResolutionService` | 17 条反例 |
| FR4 目标门禁 | 控制器内联观察/强制 | `GoalDispatchGateAdapter`（端口注入） | 5 条反例 |
| FR5 概览/预览 | 控制器内联装配 | `buildPermissionToolOverview` + 服务 | 11 条反例 |
| FR6 context 预算 | 门面内联读写 | `ContextFacet` | 5 条反例 |
| 门面 fan-in | 128 处依赖整门面 | 可按需依赖 5 个子门面 | `facade.goal` 等 getter |
| 依赖方向 | 无强制 | `verify:decoupling-imports` 规则检查 | 7 条脚本反例，并入 `test:scripts` |

### 仍未关闭的耦合（诚实记录）

1. **Mission 写路径**（submit/cancel/resume）仍在门面：状态机与幂等账本跨方法共享，尚未按 facet 拆；
2. **CLI 仅 Goal 命令**改为窄依赖；其余命令仍直接调用整门面；
3. `public-sdk.ts` 行数**未降**（签名与委托保留），"单文件 < 3000 行"目标依赖 Mission/Context 大块实现迁出；
4. `main-controller` 仍有 `projectMissionCompletionGate` 的端口装配与多处编排职责（P1 已收敛判定顺序，但控制器仍大）。

