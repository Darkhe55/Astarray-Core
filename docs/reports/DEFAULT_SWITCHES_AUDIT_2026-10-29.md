# 默认开关与阻塞项复核（2026-10-29，第 53 轮）

> 目的：确认"默认开关"的**缺省值、消费点、是否可达**与代码一致。
> 方法：静态检索 `packages/core/src/**`（记录行号），**不运行任何代码**。

## 1. 六个开关的实际状态

| 开关 | 定义处 | 缺省判定 | 消费点 | 可达性（生产装配能否打开） |
|---|---|---|---|---|
| `isConversationIdentityEnabled` | `application-runtime.ts:318` | **on**（`=== false` 才关） | `application-runtime.ts:1481` 构造 `ConversationIdentityStore` | ✅ 可达 |
| `isModelTaskPlanningEnabled` | `application-runtime.ts:332` | **off**（`=== true` 才开，且需 `workerRuntimeFactory`） | `application-runtime.ts:1492` 构造分解候选稿生产器 | ✅ 可达（需同时注入 worker 运行时） |
| `isCompletionReceiptRequired` | `application-runtime.ts:339` + `main-controller.ts:195` | **off**（`=== true` 才透传） | `main-controller.ts` `projectMissionCompletionGate` | ✅ 可达 |
| `isReviewRequiredForMerge` | `git-integration-coordinator.ts:70` | **off**（`=== true` 才 `requiresReviewer`） | `git-integration-coordinator.ts:387` | ✅ **已可达**：运行时选项 `gitIntegration.isReviewRequiredForMerge` 已透传（第 54 轮修复，ADR-0090；默认仍关） |
| `isMissionRecoveryGateEnabled` | `application-runtime.ts:346` | **off**（`=== true` 才开） | `application-runtime.ts:1519` 构造 `RecoveryCenterController` | ✅ 可达 |
| `GOAL_MODE_DEFAULT_ENABLED` | `goal-contract.ts:274` | `false`（**常量**） | **无任何引用**（全仓仅 1 处，定义自身） | ❌ **不可达**：常量只是声明，`resolveGoalModeActivation` 用的是入参，不读它 |

## 2. 复核发现（两处真实缺口）

1. **`GOAL_MODE_DEFAULT_ENABLED` 是"死常量"**：全仓仅定义处 1 次出现。
   目标模式的"默认关闭"目前靠调用方传 `isExplicitlyEnabled: false`，**不是**由该常量保证。
   这意味着任何调用方只要传 `true` 就能开，**常量不构成保护**。
2. **`isReviewRequiredForMerge` 无法从产品装配打开**：`application-runtime` 构造
   `GitIntegrationCoordinator` 时未传该字段，也没有对应的运行时选项。
   即"合并前要求审查者"这条**当前不可用**（代码存在，装配缺失）。

## 3. 其余开关的边界说明

- `isCompletionReceiptRequired` 可达，但**没有收据/裁决生产方**（ADR-0079），
  打开后会**阻断所有 done** —— 这是 fail-closed 的代价，不是缺陷。
- `isMissionRecoveryGateEnabled` 可达；默认关，故 `resumeMission` 默认不做只读对账。
- `isModelTaskPlanningEnabled` 需要**同时**提供 worker 运行时；缺任一条件即保持单节点。

## 4. 阻塞项清单（当前唯一）

| 卡 | 状态 | 阻塞原因 | 解除条件 |
|---|---|---|---|
| **REMOTE-01** | **blocked（平台阻塞）** | 两个仓库均无 IM/Webhook/邮件发送实现；`RemoteDeliveryTransportPort` 只有接口 | 见 [REMOTE01_PLATFORM_BLOCK](REMOTE01_PLATFORM_BLOCK_2026-10-28.md) 的 6 条验收条件 |

其余七张卡均为 `in_progress`（全部 `implemented-unverified`），**没有第二张 blocked 卡**。

## 5. 未做（如实）

- 两个缺口**本轮只记录、未修复**（修 `isReviewRequiredForMerge` 装配属新的代码检查点；
  让常量真正生效需要改 `resolveGoalModeActivation` 的语义，需产品确认）。
- 未运行任何代码；未验证"打开开关后的真实行为"。
- 与共享总表 `docs/reports/TASKCARD_BACKLOG_2026-10-17.md` §11 **未同步**。
