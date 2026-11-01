# GOAL-02 最终交付报告（2026-11-01）

> 卡：[GOAL-02_BOUNDED_GOAL_STABILITY](../tasks/GOAL02_BOUNDED_GOAL_STABILITY.md)
> 定位不变：交付的是**受约束目标推进**（契约/证据/门禁/暂停/恢复/退出），
> **不是**"永不偏航"的证明，也不宣称现实世界正确。

## 1. 交付概览

| 层 | 内容 | 代表位置 |
|---|---|---|
| 契约与 V | GoalContract、V=Σweight×remaining、unknown 优于伪精确、拆分守恒、安全不变量独立于 V | `goal-contract.ts` |
| 门禁 | 派发前检查、每 3 组进展检查、停滞暂停、预算取更严、执行前预算守卫、组边界复查 | `goal-dispatch-gate.ts`、`main-controller.ts` |
| 生命周期 | 提案→用户确认、创建时绑定、契约变更（K3）、失活/归档（K8）、关闭实验 | `goal-contract-proposal.ts`、`application-runtime.ts` |
| 证据 | 确定性收据证据、独立验收证据、裁决后 V 重算、证据失效（K5） | `goal-requirement-assessment.ts`、`goal-evidence-invalidation.ts` |
| 可观察 | 状态视图、判定记录（有界+归档）、违规记录（有界+归档+轮转+只读查看） | `goal-mode-store.ts`、`goal-mode-command.ts` |
| 恢复 | 恢复对账（reconcile-first/stay-paused）、组对账、任务对账、续接图修复 | `mission-orchestrator.ts`、`main-controller.ts` |
| 入口 | 公开 SDK 目标方法、CLI `goal-mode *` 与 `run --goal/--model-planning/...`、模型 `proposeGoal` 工具 | `public-sdk.ts`、`cli.tsx`、`goal-proposal-tool.ts` |

## 2. 真实 mission 证据（非单测）

| 能力 | 证据 |
|---|---|
| 提案→确认→映射→创建前绑定 | `goal-acceptance-1` 全链路 |
| 正向完成（deterministic） | `mission-6ed57632` done、V=0、收据/产物正确 |
| 模型任务分解（两节点） | `mission-0524ccd3` done、`outcome=model`、T-01/T-02 done |
| 多组预算停止 + 组边界 | `mission-c6b13c65` blocked、组数 3、目标暂停 |
| 多组正向完成 | `mission-90bc56fb` done、V=0、组数 3 |
| 证据失效 | `goal-acceptance-1` invalidate → V=1、暂停、需重规划 |
| **真实 12+ 组停滞** | `goal-realstg`：4 次 mission、14 组、checks=3 ⇒ 暂停；强制模式阻断下一单 |
| 强杀恢复闭环 | 强杀 → 组对账 → 任务对账 → resume `done`，consumed 未归零 |
| 三身份任命 + 独立裁决 | `drill-state/completion-verdicts/.../T-001.json` accepted |
| accepted 裁决 → V=0 | `mission-a21df78c` + reconcile → V=0、来源 `independent-acceptance` |
| 模型自主提议 | `proposals/goal-proposal-f5d88156-….json`，来源 `mission:<id>`、待确认 |
| 模型不守约重试 | `mission-9d01d418`：缺事件 → 有界重试 1/1 → done |
| rework 组性质 | trace：`reassign=T-02` → 第二组 `rework` 启动 → `lastTaskGroupKind=rework` |

## 3. 自动化验证

- 全量：`tests/core --maxWorkers=2` → **471 files / 3612 tests 全通过**；
- `typecheck` / `lint` / `build` 全绿；
- ADR：0145–0177 覆盖本轮全部改动；
- 唯一不稳定性：套件在负载下偶发瞬时失败（每次单跑通过/重跑 exit 0），已记录未归因。

## 4. 卡内验收到验收条件对照

见 [GOAL-02 卡 R105 映射表](../tasks/GOAL02_BOUNDED_GOAL_STABILITY.md)；9 条验收条件
全部有单测或真实证据，其中 6 条为真实 mission 证据。

## 5. 剩余（不阻塞"受约束推进"口径）

1. `investigation` 组**无本地判定信号**（设计如此，不产生）；
2. 归档读取只读主文件，不读 `.1/.2`；
3. 指令发送时机无产品级安全点保障（需同进程且组间）；
4. 协议重试计数仅在内存（重启后归零）；
5. CLI 端到端（commander 层）无自动化测试；
6. 真实 14 组（非恰好 12）——组数受 mission 节点数/中断组影响。

## 6. 明确不做/不宣称

- 不宣称"永不偏航"、Lyapunov 稳定性证明、现实世界正确性；
- 不把模型自述当证据；V=0 仅表示"已枚举要求有本地证据"；
- 不自动无限重试、不自动加资源、不自动恢复暂停目标。
