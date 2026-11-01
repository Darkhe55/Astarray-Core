# ADR-0166 多组正向完成：只读任务的确定性证据（R103，2026-11-01）

- 状态：已采纳（真实多组正向完成：两节点 done、V=0）
- 来源：用户"继续"（多组正常 V=0 收口）
- 相关：ADR-0146（确定性收据证据）、ADR-0165（多组预算停止）

## 1. 发现的问题

多组正向演练第一次失败：两节点都 `done`，但 `--goal-require-completion` 仍判"目标未完成"。
原因：`deterministic-check` 的验证收据要求 `artifactPaths.length > 0`，而**只读任务**
（如"读取文件确认"）没有产物 ⇒ 永远 `unverified` ⇒ V=1。

## 2. 改动

验证收据判定放宽为：`hasVerifiedCompletionControlEvent === true` 即视为确定性证据，
**不再要求产物路径非空**（产物对账在结案门禁另做，不在这里重复）。

两处同步：组结束的 V 计算、`recomputeGoalPotential`。

## 3. 真实证据（多组正向）

```
run … --model-planning --goal goal-mg3 --goal-require-completion
→ mission-90bc56fb status=done
status → tasks=2：T-01 done、T-02 done

goal-mg3：
  isPaused: false
  lastPotentialValue: 0
  requirementBasisCount: 1
  consumedToolCalls: 2
  lastTaskGroupKind: "normal"
  gateSnapshot.completedGroupCount: 3
```

即：**两个任务组先后完成、V 到 0、完成耦合放行、mission done**——多组正向闭环。

（前一次 `mission-b0cd3ddd` 因预算 8 被模型的重试耗尽而 blocked，说明预算守卫也在工作。）

## 4. 影响与遗留

- **证据强度下降**：现在"完成控制事件 + 完成"即可，产物存在性不再参与目标证据；
  收据里的 `artifactPaths` 仍写入，只是不作为判定条件；
- 组数累计 3（含此前中断组），未达 9 组，**停滞暂停仍未真实触发**；
- 模型重试会消耗预算（实测 8 次被耗尽），预算值需按任务复杂度设置；
- 真实 `rework` 组仍未演练。
