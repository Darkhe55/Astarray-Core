# ADR-0063 恢复前只读对账门禁（ALIGN-04-02）

- 状态：部分采纳（门禁已实装、缺省关闭；对账本体与重新授权未接）
- 日期：2026-10-28
- 来源：[ALIGN-04](../tasks/ALIGN04_RECOVERY_AND_STATUS.md) 检查点 02
- 相关：ADR-0062（关系索引）、ADR-0057（完成收据）

## 1. 背景

卡内要求：恢复先做**只读对账**（哪些已完成、租约失效、副作用未知、等待授权）；
用户可查看历史但**查看不启动任务**；**旧授权不可仅凭恢复档案重用**。

实测：

- `RecoveryCenterController`（`inspectMission` / `resumeMission` / `abandonMission`）与
  `ReadonlyReconciliationService`、`RecoveryClassificationService` 都已实现且相当完整
  （含"不确定副作用 ⇒ 阻断"、"一次性授权不延续"的字段）；
- 但 **`MainController.resumeMission` 从不咨询它们**：只要 mission 有未完成任务就重新调度，
  状态损坏、检查点声明需对账、租约冲突都不拦；
- 历史查看（`listMissions`/`inspectMission`/run-history 视图）确实是只读的，
  不会启动任务 —— 这一点**已经成立**，本轮未改动；
- 恢复路径不读取任何历史批准记录 ⇒ 旧授权**不会**因恢复被复用（既有权权限引擎仍要重新询问），
  但也没有显式"拒绝恢复档案里的授权"的检查。

## 2. 契约（冻结）

1. **恢复前门禁**：`resumeMission` 在读取任务链之前先调用 `missionRecoveryGate`；
   返回 `isAllowedToResume:false` ⇒ 抛 `mission-locked` 并**列出全部原因**，
   不写 `running`、不启动调度器。
2. **只读**：门禁只调用恢复中心的 `inspectMission`（读摘要/任务链/租约/检查点），
   **不改状态、不续接、不启动任务**。
3. **阻断条件**（当前装配的判定）：mission 不存在；`isCorrupted`（摘要或任务链损坏）；
   `reconciliationRequired`（可信检查点声明了 Git/worktree 状态 ⇒ **必须先对账**，门禁不代替对账）。
4. **查看 ≠ 恢复**：历史/检查点/恢复中心视图都是只读；恢复只能由显式 `resumeMission` 触发。
5. **不继承授权**：恢复不读取历史批准；一次性授权仍按既有权权限引擎重新询问，
   门禁**不放行**任何"恢复档案里带出来的授权"。
6. **缺省关闭**：`isMissionRecoveryGateEnabled` 缺省 `false`（未实测的收口变更不默认推送）。

## 3. 生产调用链（源码位置）

```
用户/UI 显式恢复
└─ MainController.resumeMission                             packages/core/src/orchestration/main-controller.ts
   ├─ missionRecoveryGate（可选）
   │  └─ RecoveryCenterController.inspectMission             recovery-center-controller.ts
   │     ├─ MissionManager.probeMissionDirectory             （只读摘要/任务链探测）
   │     ├─ MissionLeaseStore.readLeaseSummary               （只读租约）
   │     └─ RecoveryCheckpointStore.selectLatestTrustedCheckpoint（只读检查点）
   ├─ 被拒 ⇒ DomainError("mission-locked", 原因)
   └─ 通过 ⇒ 原有续接流程（work-window → incomplete tasks → launch*）
装配
└─ application-runtime：isMissionRecoveryGateEnabled=true 时构造门禁并传入控制器
```

## 4. 未完成（如实）

- **门禁默认关闭**：生产仍可在损坏/需对账状态下续接（未实测的变更不默认推送）。
- **门禁只拦不代劳**：`reconciliationRequired` 时只要求先对账，**不执行** Git/worktree/
  人工改动对账（`ReadonlyReconciliationService` 仍在恢复中心内部，未在门禁里调用）。
- **租约冲突未纳入**：`isLeaseActive` 没有参与判定（视图不区分"本进程持有"与"别的进程持有"）。
- **`reauthorizationRequiredTypes` 未被消费**：恢复中心会列出需重新授权的能力类型，
  `resumeMission` 不读它（因为没有持久化的一次性授权可"复用"，所以暂不阻断）。
- **未验证**：没有跑过"损坏 ⇒ 拒绝""需对账 ⇒ 拒绝""正常 ⇒ 续接"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
