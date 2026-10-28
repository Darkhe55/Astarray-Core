# ALIGN 核心返修交接（2026-10-28，60 轮窗口第 1–21 轮）

本文件是 [ALIGN-04](ALIGN04_RECOVERY_AND_STATUS.md) 检查点 06 的交付物：把 ALIGN-01…04
已做/未做的事**按调用链逐层登记**（接口存在 / 组件存在 / 生产接线 / 代码完成 / 运行证据），
并列出结构性问题、默认开关、未完成项与验证边界。

> **口径**：本窗口**没有编写或运行任何测试**（沿用任务卡"不要求编写/运行测试"的交付口径）。
> 所有"代码完成"只表示**代码已写入并通过 `typecheck` / `eslint` / `build`**，
> **不代表运行验证通过**；任何一项都**不得**被读成"已验收"。
> 证书：`npm run typecheck` exit 0、`npm run lint` exit 0、`npm run build` 成功（每轮复跑）。

---

## 1. 逐卡调用链登记

图例：**接口** = 类型/契约；**组件** = 实现类/纯函数；**接线** = 生产路径真的调用它；
**代码** = 该检查点声明的行为是否写完；**运行证据** = 是否跑过（本窗口一律"无"）。

### ALIGN-01 稳定身份与只读主 Agent

| 检查点 | 接口 | 组件 | 接线 | 代码 | 运行证据 |
|---|---|---|---|---|---|
| 01-01 会话/个体/运行身份 | ✅ | ✅ `conversation-identity-store` | ✅ 默认开（`isConversationIdentityEnabled`） | ✅ | 无 |
| 01-02 ponder 复用主个体 | ✅ | ✅ | ✅ | ✅ | 无 |
| 01-03 只读工具面 + 提案边界 | ✅ | ✅ `main-agent-proposal-contract` | ⚠️ 入口存在、**无自动调用方** | ✅ | 无 |
| 01-04 提案所需产物 | ✅ | ✅ | ⚠️ 字段贯通到任务节点；**直投消费者缺失** | ⚠️ 部分 | 无 |
| 01-05 180s 预算 | ✅ | ✅ `main-agent-turn-budget` | ✅ 仅 ponder | ✅ | 无（未用慢模型触发） |
| 01-06 报告索引 | ✅ | ✅ `main-agent-report-archive` | ⚠️ 仅 assist mission 终态写入；三级级报告无生产者 | ⚠️ 部分 | 无 |
| 01-07 旧身份只读审计 | ✅ | ✅ `legacy-identity-migration` | ✅ SDK `auditLegacyIdentityMapping` | ✅ | 无（未在真实旧目录跑） |

关键调用链（01-01）：`handleUserMessage → resolveConversationIdentityForMission →
ConversationIdentityStore.resolveOrOpen… → MissionManager.createMission → beginRun`。

### ALIGN-02 统一偏序调度主干

| 检查点 | 接口 | 组件 | 接线 | 代码 | 运行证据 |
|---|---|---|---|---|---|
| 02-01 序列先于 mission | ✅ | ✅ `publishOrInsertTask` | ✅ assist 入口 | ✅ | 无 |
| 02-02 分解校验 | ✅ | ✅ `task-decomposition-contract` + model planner | ⚠️ 模型规划**默认关**（`isModelTaskPlanningEnabled`） | ✅ | 无（未调真实模型） |
| 02-03 ready 单元选择 | ✅ | ✅ `ready-task-group-selection` | ⚠️ 只有只读入口 | ✅ | 无 |
| 02-05 派发去假值 | ✅ | ✅ 真实占用 + `claimTask/releaseClaim` | ❌ **无派发消费者** | ⚠️ 部分 | 无 |
| 02-06 运行中插入 | ✅ | ✅ `task-group-insertion-contract` | ⚠️ 只能推迟到下一组（无注入端口） | ⚠️ 部分 | 无 |
| 02-07 事件/退避/重派上限 | ✅ | ✅ | ⚠️ 仅 mission 级两个事件 | ✅ | 无（未做真实计时） |

**结构性发现（重要）**：`SecondaryContinuousDispatchLoop` **从未被生产调用** —— 真正的执行由
`MissionOrchestrator` 内部的 `dagScheduler.scheduleRound()` 驱动，且 orchestrator **没有**
"按 taskId 领取/派发/插入"的公开 API。因此 02-03/02-05/02-06 的消费者全部悬空；
**权威任务序列与 mission 任务链仍是两套记账**（序列任务会停在 `pending`）。

### ALIGN-03 执行、审查、集成与反馈

| 检查点 | 接口 | 组件 | 接线 | 代码 | 运行证据 |
|---|---|---|---|---|---|
| 03-01 独立审查门禁 | ✅ | ✅ `independent-review-gate` | ⚠️ 控制面入口，**完成门禁不强制** | ✅ | 无 |
| 03-02 任务包信包 | ✅ | ✅ `task-bundle-dispatch-envelope` | ⚠️ 持久化 + 快照可读，**执行侧不消费** | ⚠️ 部分 | 无 |
| 03-03 完成收据 | ✅ | ✅ `completion-receipt` | ⚠️ 门禁**默认关**（`isCompletionReceiptRequired`） | ✅ | 无 |
| 03-04 审查者 + 干净工作区 | ✅ | ✅ | ✅ `submitContribution` / `finalizeIntegration` | ✅ | 无 |
| 03-05 合并前证据核对 | ✅ | ✅ `git-review-evidence` | ✅ `finalizeIntegration` | ✅ | 无 |
| 03-06 反馈幂等 + 补送 | ✅ | ✅ `MailboxJournal` 去重 + client outbox | ✅ 心跳补送 | ✅ | 无（未做崩溃恢复实测） |
| 03-07 三级收口钩子 | ✅ | ✅ `tertiary-lifecycle-hooks` | ❌ **没有人调用 `shutdown()`** | ⚠️ 部分 | 无 |

### ALIGN-04 恢复与状态纠偏

| 检查点 | 接口 | 组件 | 接线 | 代码 | 运行证据 |
|---|---|---|---|---|---|
| 04-01 mission 关系索引 | ✅ | ✅ `mission-relation-index` | ✅ 启动 `hydratePersistedMissionRelations()` | ✅ | 无（未跑重启链路） |
| 04-02 恢复前只读门禁 | ✅ | ✅ | ⚠️ **默认关**（`isMissionRecoveryGateEnabled`） | ✅ | 无 |
| 04-03 就绪分类 + 租约 | ✅ | ✅ | ✅ `resumeMission` | ✅ | 无 |
| 04-04 工作时段恢复 | ✅ | ✅ | ⚠️ 入口存在、**无时段变化检测器** | ✅ | 无 |
| 04-05 胶囊回访 | ✅ | ✅ `ContextRecallController` 已构造 | ⚠️ **未注入提示词装配** | ✅ | 无 |
| 04-06 本交接 | ✅ | — | — | ✅ | 无 |

---

## 2. 默认开关一览（对行为有影响，需产品决策）

| 开关 | 缺省 | 打开后的行为变化 |
|---|---|---|
| `isConversationIdentityEnabled` | **true** | 带项目标识的消息写会话/运行映射 |
| `isModelTaskPlanningEnabled` | **false** | assist 入口真的调模型做分解（失败降级并记录） |
| `isCompletionReceiptRequired` | **false** | success 无收据 ⇒ blocked，不判 done |
| `isReviewRequiredForMerge` | **false** | 合并目标分支要求已指定审查者 |
| `isMissionRecoveryGateEnabled` | **false** | 损坏/需对账的 mission 拒绝 `resumeMission` |

---

## 3. 未完成项（按阻塞类型）

**A. 结构性问题（不是补一段代码能解决）**

1. **两套记账**：权威任务序列 vs mission 任务链。要合并需给 `MissionOrchestrator` 增加
   "按 taskId 领取/派发/插入"的公开 API，并让 `DagScheduler` 支持图变更。
2. **没有自动触发点**：任命/裁决、任务包信包、完成收据、生命周期收口、胶囊回访
   都有契约与实现，但**编排层不自动调用**。这属于"接线"而非"实现"。
3. **`SecondaryContinuousDispatchLoop` 是第二套调度器**，从未被调用。

**B. 缺生产能力的功能**

- 直投（`executeDirectDispatchCommand` 未注册、SDK 未暴露、全仓无 `publishSequence` 调用方）；
- 任务包（`createTaskBundle` 无生产调用方 ⇒ 关系索引里的 group 恒空）；
- 三级任务包级报告（只有 mission 级终态报告）。

**C. 缺外部条件**

- 人工验收体验、真实 IM 平台、macOS 平台证据、真实慢模型超时验证；
- SEC-02 DLP 策略（胶囊回访的敏感判定仍是默认启发式）。

**D. 明确的"未验证"**

本窗口**所有**检查点都没有运行证据（无测试、无实机链路）。特别地：
超时中止、崩溃恢复、租约接管、脏工作区拒绝、审查者自审拒绝、反馈补送、
胶囊回访、时段恢复，**都没有被触发过**。

---

## 4. 备份与可回溯

- 修改前的卡片副本：`.tmp/align-2026-10-28-backups/`（ALIGN00/01/02/03/04、tasks README、PLAN_STATUS）。
- 全部改动按检查点分别提交，提交信息含"为什么"与"没做什么"；`PLAN_STATUS.md` 顶部
  ㉔–㉛ 段逐条记录本轮结论与推送失败原因。
- 契约文档：`docs/adr/0044` … `docs/adr/0066`（23 份），每份都有"未完成"与"验证状态"两节。

---

## 5. 建议的下一步（按解除阻塞的收益排序）

1. **合并两套记账**（给 orchestrator 增加领取/派发/插入 API）—— 解锁 02-03/05/06、01-04 直投、03-02 信包消费；
2. **把 03-01/03-03 接进完成门禁**（任务 done 必须有独立裁决 + 完成收据）—— 这是"不伪造完成"的根；
3. 接通时段变化检测器与 `shutdown()` 调用点（04-04、03-07）；
4. 在上述接线完成后，再统一补测试与实机验证（当前口径禁止，需要用户明确授权）。
