# ADR-0196 暂停后恢复（replanGoal）与异步写失败处理（R138，2026-11-03）

- 状态：**已实现并验证**（CLI 真实夹具 + 单测；同时修掉一个 unhandled rejection）
- 来源：用户"继续"（暂停后恢复流程）
- 相关：ADR-0192/0195（图变更暂停）、ADR-0170（对账）

## 1. 新增 `replanGoal`

规则：

- 只在 `requiresReplanning === true` 时接受（否则返回 `resumed:false` 并说明，不假装恢复）；
- **必须给说明**（记录到证据缺口，可审计）；
- 清除 `requiresReplanning` / `pauseReason` / `isPaused`（状态与 gateSnapshot 同步），刷新门禁缓存；
- **不**自动重算 V、**不**自动继续派发（由用户/宿主重新提交或决定）。

入口：运行时 → 门面 `replanGoal` → CLI `goal-mode replan --goal <id> --note <text> [--json]`。

## 2. 真实 CLI 证据（夹具状态）

```
goal-mode replan --goal goal-replan --note "已重排任务并补映射"
→ {"status":"goal-resumed","resumed":true}
文件：requiresReplanning=false、pauseReason=null、evidenceGaps +1

再次调用：
→ {"status":"goal-not-replanning","resumed":false}（退出码 1）
```

## 3. 顺带修复：异步目标联动的未处理拒绝

全量套件出现 1 条 **unhandled error**（测试全过但退出码 1），来源是图变更后的
fire-and-forget 目标写入在测试清理目录后仍执行（ENOENT）。已给该 IIFE 加
`.catch(() => undefined)`（诊断写入失败不产生未处理拒绝）。

## 4. 验证

```
tests/core/goal-replan.test.ts → 2/2（恢复一次、重复拒绝；空说明/不存在目标拒绝）
真实 CLI 夹具：resumed=true → 再调用 false（退出码 1）
tests/core --maxWorkers=2 → 3652 tests 全通过、无 Errors
typecheck / lint / build → 全绿
```

## 5. 未完成

- 恢复后**不会自动继续派发**（设计如此；需用户重新提交或宿主触发）；
- 没有"重新规划"的结构化产物（只记录一段说明文本）；
- 没有把 replan 与映射更新/证据失效联动（用户需自行处理）；
- 暂停原因若是预算耗尽等其它来源，本入口**不会**清除（只清 requiresReplanning 场景）。
