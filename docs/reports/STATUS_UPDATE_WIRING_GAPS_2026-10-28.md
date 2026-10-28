# 状态补丁：跨卡接线缺口复核（2026-10-28，60 轮窗口第 36 轮）

> 本文件是**状态补丁**，不覆盖共享总表
> （`docs/reports/PRODUCT_WIRING_GAPS_MASTER_2026-11-08.md`）；待人工集成时再合并。

## 1. 范围与方法

- 复核对象：本窗口（ADR-0044…0077，12 张任务卡）新增的能力。
- 方法：**静态检索**（`Select-String` 全仓 `packages/**/*.ts(x)`），
  统计"定义处之外的调用方数量"。**没有运行任何代码**。
- 判定口径：
  - **有生产调用方** = 除定义文件外至少一处真实调用（不含注释/文档字符串）；
  - **仅定义** = 只有自身定义（或注释）出现；
  - **运行证据** = 本窗口**一律没有**（交付口径不写/不跑测试）。

## 2. 默认开关（6 个，均需产品决策）

| 开关 | 位置 | 缺省 | 打开后的行为 |
|---|---|---|---|
| `isConversationIdentityEnabled` | `application-runtime.ts:303` | **on**（`=== false` 才关） | 带项目标识的消息写会话/运行映射 |
| `isModelTaskPlanningEnabled` | `application-runtime.ts:317` | off（`=== true` 才开） | assist 入口真的调模型分解（失败降级并记录） |
| `isCompletionReceiptRequired` | `application-runtime.ts:324` | off | success 无收据 ⇒ blocked，不判 done |
| `isReviewRequiredForMerge` | `git-integration-coordinator.ts:70` | off | 合并目标分支要求已指定审查者 |
| `isMissionRecoveryGateEnabled` | `application-runtime.ts:331` | off | 损坏/需对账的 mission 拒绝 `resumeMission` |
| `GOAL_MODE_DEFAULT_ENABLED` | `goal-contract.ts:274` | **false**（常量） | 目标模式；且激活还需"用户来源 + 认证用户 + 显式请求 + 显式开启" |

> 说明：前五个是"运行时选项"，第六个是"代码常量 + 双条件"，语义不同，不能混为一谈。

## 3. 仅定义、无调用方的公开 API（本轮复核结果）

检索命令（示例）：`Select-String -Path packages/**/*.ts -Pattern '<符号>'`，
并排除 `packages/core/src/orchestration/` 定义文件后计数为 **0**。

| API | 定义位置 | 定义外调用方 | 说明 |
|---|---|---|---|
| `MainController.requestRunEvidence` | `orchestration/main-controller.ts:1776` | **0** | REMOTE-01-01 快照入口；无 CLI/UI/SDK 调用 |
| `MainController.handleWorkWindowResume` | `orchestration/main-controller.ts:1543` | **0** | 工作时段恢复入口；无时段变化检测器 |
| `MainController.recallClosedContext` | `orchestration/main-controller.ts:1597` | **0** | 胶囊回访入口；未注入提示词装配 |
| `MainController.inspectMissionResumeReadiness` | `orchestration/main-controller.ts:1628` | **0** | 只读就绪投影；无 UI/CLI 使用 |
| `evaluateOutboundContentGate` | `tools/outbound-content-gate.ts:104` | **0** | 外发门禁；无投递链路调用 |
| `GoalDispatchGate`（`new`） | `orchestration/goal-dispatch-gate.ts:138` | **0** | 目标门禁；未接派发 |
| `GoalModeStateStore` | `orchestration/goal-mode-store.ts:93` | **0** | 目标持久化；`resumeMission` 不调用 |
| `RemoteEvidenceExportService` | `orchestration/remote-evidence-export.ts:340` | **0** | 远程导出门面；运行时未构造 |
| `CredentialBroker`（`new`） | `tools/credential-broker.ts` | **0** | 凭据中介；provider 仍走既有存储 |

## 4. 已实现但未接线的能力（按卡）

| 卡 | 能力 | 缺口 |
|---|---|---|
| ALIGN-02 | 权威任务序列 / ready 选择 / 占用 / 插入 | `MissionOrchestrator` 无"按 taskId 领取/派发/插入"API；`SecondaryContinuousDispatchLoop` **从未被生产调用** |
| ALIGN-03 | 独立审查门禁、任务包信包、完成收据、生命周期收口 | 完成门禁不强制；信包执行侧不消费；`tertiary-lifecycle.shutdown()` **无调用方** |
| ALIGN-04 | 关系索引、恢复门禁、就绪分类、工作时段恢复、胶囊回访 | 关系索引已 hydrate；其余四项只有控制面入口（见 §3） |
| SEC-02 | 四态扫描、检测器目录、入口 fail-closed、子进程环境、凭据中介、外发门禁 | **模型最终出口无扫描**；MCP/摘要/日志"掩码不阻断"；无平台适配器 |
| REMOTE-01 | 快照、绑定与双步骤、幂等 outbox | 无 IM 适配器、无首次绑定流程、无独立授权通道、无 unknown 处置入口 |
| GOAL-02 | 契约与 V、门禁、持久化 | 三者都未接进派发/恢复；无 UI/CLI |

## 5. 运行证据总账

- 本窗口 **12 张卡、约 30 个检查点：运行证据 = 0**。
- 每轮只声明 `typecheck` / `eslint` / `build`（部分轮次）通过；**没有测试、没有实机链路**。
- 因此所有交付一律 `implemented-unverified`；任何"行为已生效"的说法都**不成立**。

## 6. 接线清单（按解除阻塞收益排序）

1. **合并两套记账**：给 `MissionOrchestrator` 增加"按 taskId 领取/派发/插入"公开 API，
   让 `DagScheduler` 支持图变更 —— 解锁 ALIGN-02-03/05/06、ALIGN-01-04 直投、ALIGN-03-02 信包。
2. **把 ALIGN-03-01/03-03 接进完成门禁**：任务 `done` 必须有独立裁决 + 完成收据
   （当前两个开关默认关，且门禁本身无调用方）—— 这是"不伪造完成"的根。
3. **模型最终出口加一次总扫描**（SEC-02-06 通道 13）：当前完全没有最后一道闸。
4. **接上时段变化检测器与 `shutdown()` 调用点**（ALIGN-04-04、ALIGN-03-07）。
5. **给 REMOTE-01 一个真实传输适配器**（IM 验签/发送/回执），或明确把该卡标为平台阻塞。
6. **目标模式接线**（GOAL-02）：只有接进派发与恢复，"关闭实验停止新增派发"才不是数据标记。

## 7. 限制

- 本轮是**静态复核**：不能证明"运行时一定不调用"（反射/动态注册未排除）；
  但本仓库的生产路径是显式构造，静态 0 调用方是高置信度证据。
- 未复核 `packages/tui` 的运行时注册表（若有子命令间接构造，需另查）。
- 未复核测试目录（本窗口不写/不跑测试）。
