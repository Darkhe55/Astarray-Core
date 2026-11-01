# ADR-0170 强杀重启演练与在途组对账入口（R108，2026-11-01）

- 状态：已采纳（安全性质真实验证；新增 `goal-mode reconcile`；任务级对账仍缺入口）
- 来源：用户"继续"（卡内"恢复先对账、不重复副作用"）
- 相关：ADR-0093（恢复对账）、ADR-0137（映射）、ADR-0144（失效）

## 1. 演练设计

1. 目标 `goal-mg3` 绑定一个两节点 `--model-planning` mission；
2. 在 T-01 done、T-02 running 时**强杀进程树**（`taskkill /T /F`）；
3. 等租约过期（30s TTL）后 `resume`；
4. 观察恢复门禁与后续处理。

## 2. 真实结果

**第一次 resume（kill 后立即）**：

```
mission-locked: mission 正在其他进程运行（属主 process-…），拒绝续接以避免双跑
```

（租约 30s 内正确拒绝抢跑。）

**第二次 resume（租约过期后）**：

```
DomainError: 目标模式恢复对账未通过（reconcile-first）:
  存在未收口的任务组：先对账副作用，禁止直接重跑（避免重复副作用）。
  证据缺口: goal-group-20261101055015-4-ebdaf56e
```

**新增 `goal-mode reconcile --goal --group --note`**（操作者核对副作用后收口在途组）：

```
goal-mode reconcile --goal goal-mg3 --group goal-group-… --note "…docs/rst.md 未创建，T-02 未产生副作用"
→ {"reconciled":true}
状态：currentTaskGroupIdentifier = null，consumedToolCalls 仍为 2（未被重置）
```

**第三次 resume**：

```
DomainError: 不自动恢复（需先对账/裁决）: 运行中任务副作用未知，需先对账: T-02
```

即：**任务级**在途状态仍需对账（本次未提供入口），恢复继续被正确拒绝。

## 3. 结论

- **安全性质成立**：强杀后不会盲目重跑；租约未过期拒绝抢跑；目标组与任务两级都要求先对账；
- **预算不归零**：崩溃前后 `consumedToolCalls=2` 保持；
- **新增能力**：`goal-mode reconcile` 让操作者显式收口在途**组**，且不重放工具、不推进 V。

## 4. 未完成

- **任务级对账无入口**：T-02 的"运行中"状态需要在任务链上显式收敛（重新排队或标记失败），
  当前只能人工改文件，属产品缺口；
- 没有"对账后自动继续"的一键流程；
- 本次未完成"对账后 mission 成功 done"的端到端（卡在任务级对账）；
- `goal-mode reconcile` 无自动化测试（仅真实 CLI 演练）。
