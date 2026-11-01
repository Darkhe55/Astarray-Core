# ADR-0165 多组 mission 真实演练：预算用尽 + 组边界停止（R102，2026-11-01）

- 状态：已采纳（真实证据：两节点 mission、组数累计到 3、mission blocked、目标暂停）
- 来源：用户"跑"；前序 ADR-0163/0164（模型分解 + 完成事件）
- 相关：ADR-0140（组边界）、ADR-0149（治理停止）、ADR-0159（组性质）

## 1. 演练设计

- 目标 `goal-mg`：`maximumToolCalls: 2`、`pauseConditions: ["budget-exhausted"]`、
  `req-1 → [T-01, T-02]`（模型规划产出的节点 id）。
- 任务：两步（创建 `docs/mg.md`、再读取它），`--model-planning` 产出两节点。
- 运行：`--goal goal-mg --goal-enforce`。

## 2. 真实结果

```
mission-c6b13c65
  status=blocked（CLI 输出与 summary.json 一致）
  tasks=2（taskPlanningOutcome=model）
    T-01 done
    T-02 failed

日志：
  [需要用户] 目标工具调用预算已用尽，mission 停止：…（已执行 2，上限 2）：拒绝执行 readFile。
  [目标门禁] 阻断派发：…（同上）
  [需要用户] 目标门禁在组边界拒绝继续调度: …（同上）

goal-mg 状态：
  isPaused: true
  pauseReason: "目标工具调用预算已用尽（已执行 2，上限 2）：拒绝执行 readFile。"
  consumedToolCalls: 2
  lastPotentialValue: 1
  lastTaskGroupKind: "normal"
  gateSnapshot.completedGroupCount: 3
```

## 3. 证明了什么

1. **多组真实发生**：模型拆分出 2 个节点，T-01 完成（第一组）、T-02 在执行中被预算拦住（第二组），
   组计数累计到 3（含一次中断组）；
2. **组边界停止真实触发**：边界门禁在组间复查时拒绝继续调度，mission 以 `blocked` 结束
   （不是 `cancelled`/`done`），CLI 与磁盘一致；
3. **治理停止 + 目标暂停**：`isPaused` 与预算原因落盘、`consumedToolCalls=2` 与"已执行 2"一致；
4. **组性质持久化生效**：`lastTaskGroupKind = "normal"`。

## 4. 未覆盖

- 未跑到"连续 3 次检查 V 未降 ⇒ 停滞暂停"（需要 9+ 个普通组）；本次只到组数 3；
- 未验证"多组完成后 V=0 的正常收口"（预算先耗尽）；
- 未验证 `rework` 组性质在真实 mission 中落盘（只有单测）。
