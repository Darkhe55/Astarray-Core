# ADR-0177 真实 12+ 组停滞（无预置）与强制阻断（R116，2026-11-01）

- 状态：**已真实跑到**（4 次真实 mission 累计 14 组 ⇒ 暂停；强制模式阻断下一单）
- 来源：用户"继续"；ADR-0167 遗留"真实跑满 12 组（历史为预置）"
- 相关：ADR-0162（每三组检查单测）、ADR-0165（多组预算停止）、ADR-0140（组边界）

## 1. 做法（这次没有预置状态）

- 目标 `goal-realstg`：`req-1 → T-999`（不存在的节点，V 恒为 1）、`pauseConditions: ["stagnation"]`、
  预算 30；
- 依次跑 4 次真实 mission（`--model-planning`，每次两节点：创建 + 读取），只观察不强制；
- 每次读目标状态，直到出现暂停原因。

## 2. 真实结果

```
run 1 → status done   groupCount=4  checks=0 paused=false
run 2 → status done   groupCount=7  checks=1 paused=false
run 3 → status done   groupCount=10 checks=2 paused=false
run 4 → status done   groupCount=14 checks=3 paused=true
      pauseReason: "连续 3 次进展检查 V 未下降。"
```

**强制模式阻断下一单**：

```
run … --goal goal-realstg --goal-enforce
→ [目标门禁] 阻断派发：连续 3 次进展检查 V 未下降。
→ 任务提交失败（退出码 2），stg-block.md 未创建
```

## 3. 结论

- "每三个已结束组检查一次进展、连续三次不降 ⇒ 暂停自动派发"在**真实多组累积**下确实触发，
  无需预置历史；
- 暂停原因如实落盘，观察模式的 mission 仍正常 done（不影响收口）；
- 强制模式下**下一次派发被启动前拦截**，无副作用。

## 4. 未完成 / 注意

- 组数 14 而非恰好 12：一次 mission 的节点数/中断组会影响计数（本次前三次各 3 组、第四次 5 组）；
- 该目标 `req-1 → T-999` 永不满足是**刻意构造**（为了 V 不下降），不是真实业务目标；
- `investigation` 组仍无信号；
- 本次为真实付费模型调用（4 次 mission）。

## 5. 验证

```
tests/core --maxWorkers=2 → 471 files / 3612 tests 全通过
typecheck / lint / build → 全绿
真实累积：4 次 mission、14 组、checks=3 ⇒ 暂停；强制模式阻断
```
