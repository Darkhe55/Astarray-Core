# MISSION-WRITE-01：Mission 写路径真正迁出（submit / cancel）

状态：**切片 1–3 已完成；切片 4 的 submitTask 已完成，cancelTask 待迁**（2026-11-28）。基线：`7141e42c`。

## 0. 背景

P2 子门面拆分时，mission 写路径（`submitTask` / `cancelTask`）只做了**薄委托**：

- `MissionFacet.submitTask/cancelTask` 直接调用门面同名方法；
- 状态机、幂等账本、指令窗口、槽位补位、任务监视器仍在 `AstarrayApplicationFacade` 内。

本次要“真正迁出”：让门面只保留端口装配与公共 API 形状，把状态与规则搬进独立模块。

## 1. 现状核对（源码事实）

| 事实 | 位置 |
|---|---|
| `submitTask` 方法体 **421 行**（`public-sdk.ts` 6340–6760），`cancelTask` 紧随其后的独立方法 | `public-sdk.ts` |
| 门面私有状态：`tasksByTaskIdentifier`（10 处）、`taskIdempotencyLedger`（31 处）、`queuedTaskIdentifiers`（5 处）、`sessionStates`（8 处） | `public-sdk.ts` |
| 指令窗口：`admitInstructionForTask`（2 处）、`releaseInstructionSlotAndDispatchNext`（4 处）、`startTaskMonitor`（3 处）、`stopTaskMonitor`（4 处） | `public-sdk.ts` |
| 幂等账本落盘：`persistTaskIdempotencyLedger`（3 处） | `public-sdk.ts` |
| 事件发射 `emit`、事件序号 `nextEventIdempotencyId` 由门面持有，被写路径多处调用 | `public-sdk.ts` |

结论：写路径不是"单方法 + 窄端口"，而是**共享状态机**：任务记录、幂等账本、会话校验、排队槽位、监视器五者跨方法互相引用。因此必须**按状态切分**迁移，不能按方法整体搬运。

## 2. 切片计划（每一步可独立提交、可回滚）

**切片 1：任务记录与幂等账本 → `MissionTaskRegistry`（纯状态容器）— 已完成**

- 已落地：`orchestration/mission-task-registry.ts`（`evaluateIdempotentSubmission` 纯函数 +
  `computeTaskSubmissionInputHash` + `MissionTaskRegistry` 容器）；
- 门面 `submitTask` 的 claim 分支改为调用纯函数，**错误码与文案逐字不变**；状态仍由门面持有；
- 反例 10 条（含跨会话隔离、claim 未结算、容器 round-trip、哈希分隔符碰撞）。

- 新模块 `orchestration/mission-task-registry.ts`：
  - 持有 `tasksByTaskIdentifier` 与 `taskIdempotencyLedger` 的内存结构；
  - 只做 get/set/delete/claim/settle/serialize 等**状态操作**，不含错误策略与事件发射；
  - 幂等语义（同键同参复用、异参拒绝、claim-pending）以**纯函数** `evaluateIdempotentSubmission` 表达，返回 `{kind:"reuse"|"conflict"|"claim-pending"|"claim"}`；
- 门面改为持有 `MissionTaskRegistry` 实例，`submitTask` 中的账本操作改调 registry（控制流与错误文案保持逐字不变）；
- 反例：同键同参复用、异参冲突、claim 未结算、跨会话隔离、序列化 round-trip 后仍可复用。

**切片 2：会话/任务校验结果 → 纯函数（已完成）**

- 已落地：`evaluateExistingTaskForSubmission`（absent / reuse / session-mismatch）；
- 门面 `submitTask` 的既有任务分支改调纯函数，错误码与文案逐字不变；
- 反例 3 条（无既有任务、同会话复用、跨会话不匹配）。

- 把 `requireSession` / `requireTask` 的校验结果与错误码改为纯函数输出（不改 throw 形状）；
- 反例：未知会话、任务不属于会话、已存在同 taskIdentifier。

**切片 3：排队槽位与监视器 → 端口化**
- 指令窗口与监视器保留门面实现，但以端口注入 `submitTask` 编排函数；
- 反例：窗口满 ⇒ queued 且不启动 mission；槽位释放只补一条；取消排队任务不占槽位。

**切片 4：编排函数搬到 `orchestration/mission-submission-service.ts`（submitTask 已完成）**

- 已落地 `MissionSubmissionService.submitTask`：幂等判定 → 既有任务 → ponder/目标 Agent/执行根 → 准入 →
  排队/提交 → 记录 → 结算 → 事件 → 监视器；状态全部经端口注入（门面持有）。
- 门面 `submitTask` 方法体只剩一行委托；`cancelTask` 尚未迁移。
- 反例 8 条（排队不启动、受理结算、ponder、冲突/挂起、复用、跨会话、校验仅在提供时、提交失败透传）。

- 门面只保留 `createMissionFacet()` 端口装配与方法转发；
- 反例：ponder 拒绝、目标 Agent 不存在/已回收、执行根非绝对/不存在、重复 taskIdentifier 会话归属。

## 3. 纪律

- 每切片先写反例，再改实现；公共行为（错误码、文案、事件顺序）逐字保持；
- 每切片跑 `typecheck/lint/test/test:scripts/隐私/解耦规则` 并提交推送；
- 不做"一次性大爆炸"重写：切片之间保持测试全绿；
- 若某切片触发跨方法状态无法收敛，记录原因并停在上一绿点，不硬拆。

## 4. 验收

- `submitTask`/`cancelTask` 方法体从门面消失（或仅剩 ≤ 20 行编排转发）；
- 任务记录与幂等账本逻辑可在**无门面**的情况下单测（端口注入）；
- 全量测试全绿、覆盖率不低于 83.05%；
- 文档同步：本卡状态、`PLAN_STATUS`、必要时 `REFACTOR_PLAN` P2 状态。
