# STARTUP-RECOVERY：启动自动恢复任务卡

日期：2026-11-05。状态：**in_progress（Phase 1 已交付）**。
范围：公开核心（策略/扫描/恢复执行/选择器）+ 私有 UI（设置与报告展示，另行提交）。

## 0. 目标与口径

- 启动时自动恢复**被中断**的任务序列（mission 为 `running` 或 `blocked`，且租约已过期/不存在）；
- 用户可控：每次启动恢复数量上限、并发上限、任务类型、是否需确认；
- 终态（done/cancelled/failed）永不自动恢复；用户取消过的不恢复；
- 含写任务、需要权限放宽的任务**默认不自动恢复**；
- 恢复是"继续原 mission"，不是重建任务；序列节点保持原状态，终态回执走 ALIGN-02-05 的同一路径。

## 1. 判据（Phase 1，只读扫描）

候选必须同时满足：

1. 关系索引存在 mission ↔ 序列/任务/所有者映射（缺映射不猜）；
2. mission 非终态；
3. 租约已过期或不存在（有效租约 ⇒ 有进程在跑）；
4. 序列任务状态为 `running` / `blocked`；
5. 标签在 `allowedTaskLabels` 内，且不在 `requireConfirmationFor` 内。

默认策略（`DEFAULT_STARTUP_RECOVERY_POLICY`）：

```json
{
  "isEnabled": false,
  "maximumResumePerStartup": 3,
  "maximumConcurrentResumes": 1,
  "allowedTaskLabels": ["normal"],
  "requireConfirmationFor": ["has-writes", "needs-permission"],
  "maximumAttemptsPerTask": 2,
  "cooldownMilliseconds": 30000,
  "startupDelayMilliseconds": 3000
}
```

## 2. 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | 策略存储 + 只读候选扫描 + 报告（不恢复） | **已交付（2026-11-05）** |
| Phase 2 | 启动按上限/并发恢复 + 租约领取 + 幂等 | 待做 |
| Phase 3 | 类型派生标签（goal/含写/需授权）+ 确认 | 待做 |
| Phase 4 | 排序、冷却、失败上限、审计报告 | 待做 |

## 3. Phase 1 交付（2026-11-05）

| 文件 | 作用 |
|---|---|
| `packages/core/src/orchestration/startup-recovery-policy.ts` | 策略类型/默认值/严格校验/原子读写 |
| `packages/core/src/orchestration/startup-recovery-scanner.ts` | 候选判定、排序、上限、只读报告 |
| `application-runtime.ts` | `scanStartupRecovery()` 只读入口（真实关系索引/租约/序列） |

证据：

- `startup-recovery-phase1.test.ts`（9/9）：默认值、非法值拒绝、未落盘默认、写入回读、
  租约有效/终态/缺映射/非可恢复状态跳过、关闭时只扫描、排序与上限、类型/确认过滤、端口扫描；
- `startup-recovery-scan.test.ts`：运行时真实读取关系索引/租约/序列，识别被中断 mission。

**Phase 1 边界（如实）**：

- 标签恒为 `unknown`（Phase 3 才派生）⇒ 默认策略（只允许 `normal`）不会自动恢复任何任务；
- 没有任何恢复执行；`scanStartupRecovery` 只读；
- GUI 尚未展示该报告。

## 4. 后续阶段要点

- Phase 2：`MissionLeaseStore.tryAcquire` 原子领取恢复权；按 `maximumConcurrentResumes` 分批；
  每批间隔 `cooldownMilliseconds`；恢复幂等键 `startup-recovery:<processInstanceId>:<missionId>`；
  失败写审计，达 `maximumAttemptsPerTask` 停手并标 blocked。
- Phase 3：从 mission 元数据派生标签（mode/goal/写工具/权限询问），不读 prompt 文本；
  `has-writes`/`needs-permission` 默认 `requireConfirmationFor`。
- Phase 4：启动延迟 + 工作时段/目标门禁复核 + 启动报告（selected/skipped/failed）+ GUI 展示。
