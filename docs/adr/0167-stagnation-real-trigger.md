# ADR-0167 停滞暂停的真实验证（R104，2026-11-01）

- 状态：已采纳（真实组结束触发暂停 + 强制模式下阻断下一 mission）
- 来源：用户"继续"（卡内最后未真实触发的门禁行为）
- 相关：ADR-0162（每三组检查单测）、ADR-0140（组边界）、ADR-0141（暂停条件）

## 1. 为什么需要预置历史

停滞暂停要求"连续 3 次检查 V 未下降"，即约 **12 个普通组**；每次真实 mission 只产 1–2 组，
逐次跑需要 6–12 次真实模型调用，成本高且不可控（模型行为会波动）。

因此本次采用**预置历史 + 真实最后一组**：
- 目标 `goal-stag`：`req-1 → T-999`（永远不存在的节点，V 恒为 1）；
- 直接把状态里的 `completedGroupCount` 预置为 8、`checksSinceLastReduction` 预置为 2（模拟已检查两次未降）；
- 然后**真实跑一个 mission**，让第 9/10 个组结束走真实 `recordGroupCompletion`。

> 预置只改测试目录里的状态文件（`test/state`），不改产品代码、不伪造 V。

## 2. 真实结果

```
run … --goal goal-stag（只观察，未强制）
→ mission-894385cf status=done（观察模式不影响任务）

goal-stag：
  pauseReason: "连续 3 次进展检查 V 未下降。"
  isPaused: true
  lastPotentialValue: 1
  gateSnapshot.completedGroupCount: 10
  gateSnapshot.checksSinceLastReduction: 3
```

**强制模式下阻断下一 mission**（验证暂停真的生效）：

```
run … --goal goal-stag --goal-enforce
→ [目标门禁] 阻断派发：连续 3 次进展检查 V 未下降。
→ 任务提交失败（退出码 2），stag2.md 未创建
```

## 3. 结论

- "连续三次检查 V 未下降 ⇒ 暂停自动派发"在真实组结束路径上**确实触发**，
  且原因如实写入状态；
- 暂停在**强制模式**下确实阻断下一次派发（启动前门禁），无副作用；
- 观察模式不影响已完成 mission 的收口（status done）。

## 4. 未完成 / 限制

- 历史是**预置**的（8 组），不是 12 个真实 mission 跑出来的；真实"跑满 12 组"仍未演练；
- 预置脚本只在 `test/`，未入库；
- `rework` 组不计停滞仍只有单测；
- 暂停后**没有自动恢复**（需用户/宿主处理，符合既有语义）。
