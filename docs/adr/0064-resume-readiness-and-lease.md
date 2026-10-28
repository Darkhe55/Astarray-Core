# ADR-0064 恢复：就绪分类、已产出待对账与租约幂等领取（ALIGN-04-03）

- 状态：部分采纳（判定与租约已接；对账动作未实现）
- 日期：2026-10-28
- 来源：[ALIGN-04](../tasks/ALIGN04_RECOVERY_AND_STATUS.md) 检查点 03
- 相关：ADR-0063（恢复门禁）、ADR-0062（关系索引）

## 1. 背景

卡内要求：获得现有合法恢复许可后，从**未完成且 ready** 的节点恢复；执行**恢复租约幂等领取**；
**已产出但未回执的结果先对账**，不盲目重跑；**不确定副作用保持待裁决**。

实测：

- `resumeMission` 把"所有非 done 任务"整体重新调度 —— 包括崩溃时处于 `running`
  （副作用未知）、`blocked`（等待裁决）、以及**已写 `resultLocation` 但未回执**的任务；
- 租约 `tryAcquire` 对**同进程重入**也返回 `locked-active`（恢复会把自己挡在门外）；
- `takeOverExpiredLease` 存在但没有任何调用方；编排器遇到 `locked-stale` 只会抛
  "过期待接管" ⇒ 崩溃后必须干等到租约自然过期，且没有人接管。

## 2. 契约（冻结）

1. **分类而非"全量重跑"**：
   - `running` ⇒ **副作用未知**（崩溃时在途）；
   - `blocked` ⇒ **等待裁决**；
   - `resultLocation` 非空且未 `done` ⇒ **已产出未回执**；
   以上任一类存在 ⇒ `isAutoResumable=false`，`resumeMission` 抛 `mission-locked` 并**列出任务 id**。
2. **ready 与等待依赖分开**：`pending` 且全部前驱 `done` ⇒ ready；否则等待依赖（仅展示，不提前执行）。
3. **只读投影**：`inspectMissionResumeReadiness(missionId)` 返回同一份分类结果，供 UI/CLI 对账；
   **查看不启动任务**。
4. **租约幂等领取**：
   - 同一 `processInstanceId` 已持活动租约 ⇒ `acquired-reentrant`（幂等，不再报锁）；
   - 别的进程持**活动**租约 ⇒ 恢复拒绝，不抢正在运行的 mission；
   - **过期**租约 ⇒ 按 `leaseRevision` 乐观接管（`takeOverExpiredLease`），重试幂等。
5. **不重建第二套恢复逻辑**：状态判定复用任务链；租约复用 `MissionLeaseStore`；
   恢复门禁仍是 ADR-0063 的只读对账。

## 3. 生产调用链（源码位置）

```
MainController.resumeMission                          packages/core/src/orchestration/main-controller.ts
├─ missionRecoveryGate（ADR-0063）
├─ getMissionStatus → projectMissionResumeReadiness
│  └─ 有 running/blocked/produced-unacked ⇒ DomainError("mission-locked", 任务清单)
├─ prepareResumeLease
│  └─ MissionLeaseStore.readLeaseSummary / takeOverExpiredLease（revision CAS）
└─ 原有续接：work-window → incomplete tasks → launch*
查看（只读）
└─ MainController.inspectMissionResumeReadiness
```

## 4. 未完成（如实）

- **没有"对账动作"**：判定会拒绝 `running`/`blocked`/已产出未回执的任务，但**没有**命令把它们
  放回 `pending`、确认回执或裁决副作用。人只能靠既有 `unblock`/`reassign` 或手工处理，
  且这些动作不会记录"对账结论"。
- **已产出未回执的核对只是"有 resultLocation"**：没有核对产物内容/revision 是否与任务一致。
- **租约接管只处理"已过期"**：不能判断"所有者进程已死但租约未过期"（需要心跳/进程探测），
  所以崩溃后仍可能要等到 TTL。
- **未验证**：没有跑过"崩溃留下 running ⇒ 拒绝恢复""过期租约 ⇒ 接管后成功"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
