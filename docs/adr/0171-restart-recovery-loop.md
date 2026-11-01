# ADR-0171 强杀恢复闭环：任务级对账 + 续接图修复（R109/R110，2026-11-01）

- 状态：**已闭环并真实跑通**（强杀 → 对账 → resume → done，预算未重置）
- 来源：用户"继续"；ADR-0170 遗留"任务级对账无入口"
- 相关：ADR-0170（组对账）、ADR-0093（恢复对账）、ADR-0165（多组）

## 1. 新增

1. **任务级对账** `goal-mode reconcile-task --mission --task --note`：
   - 只允许 `running`/`blocked` 任务；把状态改回 `pending` 并 **revision+1**；
   - 不重放已完成动作、不改 mission 终态、不推进 V；对账说明写回执（CLI 输出）。
2. **续接图修复**（真实 bug）：`resumeMission` 原来只把**未完成任务**传给调度器，
   导致 `T-02 依赖不存在的任务 T-01`（`TaskGraph` 校验失败）。改为传**完整任务链**
   （已完成节点带 `done` 进入图，调度器不会重跑）。

## 2. 真实闭环证据

```
1) 强杀（T-01 done / T-02 running）→ 租约 30s 内 mission-locked；过期后 reconcile-first
2) goal-mode reconcile --goal goal-mg3 --group … --note …        → reconciled:true
3) resume → 仍拒绝：运行中任务副作用未知: T-02
4) goal-mode reconcile-task --mission mission-4f635f68 --task T-02 --note …
   → reconciled:true, previousStatus:"running"（T-02 → pending）
5) 等租约过期后 resume
   → {"missionId":"mission-4f635f68","status":"done","resumed":true}
   → task-chain: T-01 done、T-02 done
   → goal consumedToolCalls: 2（崩溃前后一致，**未归零**）
```

即：**安全（不盲目重跑）→ 可对账 → 可继续 → 正常完成**，且预算持久化未被重置。

## 3. 验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3601 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 真实演练：见 §2。

## 4. 未完成

- `reconcile` / `reconcile-task` **无自动化测试**（本次为真实 CLI 演练）；
- 对账后仍需人工分两步（组 → 任务），没有"一键对账并继续"；
- `consumedToolCalls` 在恢复组完成后未增加（本场景 T-02 只读、无收据计数），与"执行了读取"不一致——已知口径限制；
- 租约过期仍需等待（30s），没有"强制接管"操作。
