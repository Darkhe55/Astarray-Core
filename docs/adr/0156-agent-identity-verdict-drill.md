# ADR-0156 三 Agent 身份与真实独立裁决演练（②，2026-11-01）

- 状态：**裁决链路已真实跑通**（任命 + 裁决 + 落盘）；V=0 的 `independent-acceptance` 端到端仍未跑
- 来源：用户"继续"（②）
- 相关：ADR-0154（裁决面）、ADR-0146（证据来源）

## 1. 发现的接线缺口

`MainController.resolveIndependentReviewGate` 从 `options` 取 `completionVerdictStore` 与
`registeredAgentDirectory`，但**运行时创建控制器时没有传裁决存储** ⇒ 裁决只做校验、**不落盘**
（演练首次运行 `APPOINT_AND_VERDICT_OK` 但 `completion-verdicts/` 为空，实证）。
身份目录本来已传，故"未登记验收者"会被拒。

## 2. 改动

1. 运行时创建 `MainController` 时传入 `completionVerdictStore`（修复落盘）。
2. 新增 `registerAgentIdentity`（运行时 + 公开 SDK）：只写 `RegisteredAgentDirectory`
   （身份/角色/mission/直属次级），不创建记忆或上下文 —— 供演练与宿主登记。
3. 演练脚本 `test/verdict-drill.mjs`（不属仓库）：
   - 登记 3 个 tertiary（实现/测试/验收，均属 `secondary:drill`、mission=drill）；
   - `appointIndependentReview`（低风险、三身份互异）；
   - `recordIndependentVerdict`（`merge-ready`、证据 `tool-call:createProjectFile:ok`、理由非自报）。

## 3. 真实证据（2026-11-01 01:47）

```
APPOINT_AND_VERDICT_OK
test/drill-state/completion-verdicts/mission-drill-1/T-001.json
{
  "schemaVersion": 1,
  "record": {
    "missionIdentifier": "mission-drill-1",
    "taskIdentifier": "T-001",
    "verdict": "accepted",
    "reasons": ["独立核对了工具调用结果与产物路径"],
    "deciderAgentInstanceIdentifier": "tertiary:accept-1",
    "decidedAtIso": "2026-10-31T17:47:19.201Z"
  }
}
```

拒绝路径也已具备（同一门禁）：
- 验收者未登记 / 角色不是 tertiary / 跨 mission / 非直属次级 ⇒ 任命被拒；
- 证据全是 `self-report:`/`executor-report:`/`agent-claim:` ⇒ 裁决被拒。

## 4. 未完成（如实）

**用 accepted 裁决把 `req-1` 推到 V=0 的端到端仍未跑**：
V 在**组结束时**计算，而 accepted 裁决只能在任务完成后记录；一次单任务 mission 的组结束
早于裁决写入。要真跑通需要：
- 方案 A：任务完成 → 记录裁决 → **下一个组**触发 V 计算（需要多组 mission）；
- 方案 B：给 V 计算加"裁决变更后重算"入口（新能力，需产品决定）。

当前 `independent-acceptance` 证据规则已有单测覆盖（有 accepted 裁决 ⇒ valid，来源标注正确）。

## 5. 验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3591 tests 全通过**；
- `typecheck` / `lint` / `build` 绿；
- 演练：任命 + 裁决 + accepted 落盘（真实文件）。
