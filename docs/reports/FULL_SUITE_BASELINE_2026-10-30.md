# 全量 `tests/core` 基线（2026-10-30，R66）

> 本窗口此前**从未运行全量测试**。用户授权针对性单测后，顺带跑了一次 `npx vitest run tests/core`
> 作为基线，用于区分"我的改动引入的失败"与"既存失败"。
> **结果：`Test Files 5 failed | 462 passed (467)`，`Tests 7 failed | 3534 passed (3541)`。**

## 1. 失败分类（逐条核对，不猜）

| # | 测试 | 现象 | 归因 | 是否本窗口引入 |
|---|---|---|---|---|
| 1–3 | `tests/core/integration/reliability-merge-reconciliation.test.ts` ×3 | `unresolvedRisks` 含"共享仓库存在未提交改动" | 测试断言**工作树必须干净**；当前工作树有**非本窗口**的 `docs/tasks/RESUME02_EXPERIMENTAL_SMART_CONTINUATION.md` 改动 | ❌ 由该未提交文件导致（你此前就有，我未替你提交/丢弃） |
| 4 | `tests/core/unit/sensitive-content-access.test.ts` | 期望消息含 `dlp:api-key`，实际是 `vendor:openai-style-api-key` | **规则标识早已改名**，测试断言未同步 | ❌ 既存（与 DLP 规则注册表重构有关） |
| 5 | `tests/core/unit/ar07-module-gaps-6.test.ts` | `activeClient.flushPendingOutbox is not a function` | 测试里的**假 client 缺方法**（实现新增了 `flushPendingOutbox`） | ❌ 既存测试夹具过期 |
| 6 | `tests/core/integration/context-node-lifecycle.test.ts` | `ENOENT ... context-graphs` | Assist 路径**没有生成该目录**（需要单独查是行为缺口还是断言过期） | ❌ 与本轮改动无关（未触碰上下文图） |
| 7 | `tests/core/integration/model-binding-runtime-switch.test.ts` | 并行跑失败 | **单独跑通过**（2.67s, 1 passed）⇒ 并行下的不稳定/超时 | ❌ 既存 flaky |

**结论**：**7 个失败没有一个由 R61–R65 的改动引起**（改动文件：`goal-task-group-kind`、
`goal-task-group-identifier`、`goal-dispatch-verdict-journal`、`mission-orchestrator` 的组边界段）。

## 2. 复现命令

```powershell
cd astarray
npx vitest run tests/core                       # 7 failed / 3534 passed
npx vitest run tests/core/integration/model-binding-runtime-switch.test.ts  # 单独跑通过
npx vitest run tests/core/unit/ar07-module-gaps-6.test.ts                   # flushPendingOutbox
npx vitest run tests/core/unit/sensitive-content-access.test.ts            # dlp:api-key
npx vitest run tests/core/integration/reliability-merge-reconciliation.test.ts
npx vitest run tests/core/integration/context-node-lifecycle.test.ts
```

## 3. 建议（按成本）

| 项 | 建议 | 成本 |
|---|---|---|
| 1–3 merge 对账 | 你决定 `RESUME02_...md` 提交或丢弃后，这 3 条应恢复 | 低（你的决定） |
| 4 DLP 规则名 | 把断言改为当前规则标识（`vendor:openai-style-api-key`），或断言"包含任一已知前缀" | 低 |
| 5 feedback 夹具 | 给假 client 补 `flushPendingOutbox: () => Promise.resolve()` | 低 |
| 6 context-graphs | 先查"Assist 是否应生成 context-graphs"——**可能是真缺口**，不能先改断言 | 中 |
| 7 flaky | 单独跑通过；需要时加超时/隔离，不急于改 | 低 |

## 4. 状态

**基线已记录**；未修改任何测试或产品代码。**这 7 条失败保持原样**，等你决定是否修。
