# ADR-0151 关闭时序：CLI 等终态落库 + 失败任务终态为 blocked（R87，2026-11-01）

- 状态：已采纳（**CLI 输出已正确**；持久化 summary 仍有 cancelled 残留，见 §4）
- 来源：用户"继续"（ADR-0150 遗留的 mission 终态问题）
- 相关：ADR-0150（终态单点）、ADR-0149（治理停止）

## 1. 根因（R86 定位的时序）

CLI 一看到任务失败就 `shutdown()` → `scheduler.cancel()` → `finishMission("cancelled")` 先落库；
治理停止的 `blocked` 随后被终态单点拒绝 ⇒ 对外看到 `cancelled`（"用户取消"），语义错误。

## 2. 改动

1. **orchestrator 记录失败事实**：`hasFailedTask`（治理失败与普通失败两条分支都置真）。
2. **关闭时的终态**：循环退出/租约停止时用 `hasFailedTask ? "blocked" : "cancelled"`，
   不再把"有失败任务"写成"用户取消"。
3. **CLI 关闭前等终态落库**：`run` 在任务终态后，最多 3 秒轮询**原始 mission 摘要状态**
   （`queryMissionRawStatus`，绕过公开映射，避免把短暂 blocked 报成 running），
   等到 `done/cancelled/blocked/failed` 再进入 shutdown。

## 3. 真实复跑（goal-k10i，上限 1）

```
run … --goal goal-k10i --goal-enforce
→ {"missionId":"mission-bcc7ee68","status":"blocked","permissionAsk":"requires-human-resubmission"}
```

**CLI 输出已从 `cancelled` 变为 `blocked`**（用户可见的修复）。

## 4. 仍未解决（如实）

- **持久化 summary 仍是 `cancelled`**：`mission-bcc7ee68/summary.json` 复核为 cancelled。
  说明 shutdown 的 cancel 仍先完成写入（或 `hasFailedTask` 在 cancel 时尚未置真），
  而公开查询（`queryMission`）读的是该 summary —— 即"CLI 打印 blocked、随后再查是 cancelled"。
- 终态单点只挡"不同终态覆盖"，挡不住"先 cancelled 后 blocked 被忽略"的次序问题；
- `permissionAsk: requires-human-resubmission` 仍在无询问时出现。

## 5. 验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3588 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- G5 早停续跑：2/2（上一轮已修，本轮未回归）；
- 真实复跑：CLI 状态 `blocked`；持久化 summary 仍 `cancelled`（未修）。
