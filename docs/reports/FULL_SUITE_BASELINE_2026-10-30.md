# 全量 `tests/core` 基线（2026-10-30，R66）

> 本窗口此前**从未运行全量测试**。用户授权针对性单测后，顺带跑了一次 `npx vitest run tests/core`
> 作为基线，用于区分"我的改动引入的失败"与"既存失败"。
> **结果：`Test Files 5 failed | 462 passed (467)`，`Tests 7 failed | 3534 passed (3541)`。**

## 1. 失败分类（逐条核对，不猜）

| # | 测试 | 现象 | 归因 | 是否本窗口引入 |
|---|---|---|---|---|
| 1–3 | `tests/core/integration/reliability-merge-reconciliation.test.ts` ×3 | `unresolvedRisks` 含"共享仓库存在未提交改动" | **更正**：假 `gitProcess.run` 对除 merge/merge-base 外的所有命令都返回 `stdoutText: "ok"`，包括实现新增的 `git status --porcelain --untracked-files=no` 预检 ⇒ 非空输出被判定为"工作区脏" ⇒ `stale-human-change` ⇒ 记入风险。**与工作树里那份未提交文件无关**（git 被完全替换） | ❌ 测试夹具过期（未适配新增预检） |
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
| 1–3 merge 对账 | **修测试夹具**：在假 `gitProcess.run` 里对 `gitArguments[0] === "status"` 返回**空 stdout**（模拟干净工作区） | 低（仅测试） |
| 4 DLP 规则名 | 把断言改为当前规则标识（`vendor:openai-style-api-key`），或断言"包含任一已知前缀" | 低 |
| 5 feedback 夹具 | 给假 client 补 `flushPendingOutbox: () => Promise.resolve()` | 低 |
| 6 context-graphs | 先查"Assist 是否应生成 context-graphs"——**可能是真缺口**，不能先改断言 | 中 |
| 7 flaky | 单独跑通过；需要时加超时/隔离，不急于改 | 低 |

## 4. 状态

**基线已记录**；未修改任何测试或产品代码。**这 7 条失败保持原样**，等你决定是否修。

## 5. 更正（同日，用户追问后复核）

最初把 1–3 归因为"工作树里那份未提交的 `RESUME02_...md`"。**该归因错误**：
测试把 `gitProcess` 完全替换，实现里新增的 `git status --porcelain --untracked-files=no` 预检
走的是**假 run**，它对除 merge/merge-base 外的命令一律返回 `stdoutText: "ok"` ⇒ 被判为脏。
**提交或丢弃 `RESUME02_...md` 不会改变这 3 条测试结果**。
（真实运行中，未提交改动**确实会**阻止自动合并——那是产品行为，与此测试无关。）

## 6. 修复结果（同日，R67）

| 原失败 | 处理 | 结果 |
|---|---|---|
| merge 对账 ×3 | 夹具对 `git status` 返回**空 stdout**（干净工作区） | ✅ 3/3 通过 |
| DLP 断言 | 改为当前规则标识 `vendor:openai-style-api-key` | ✅ 14/14 通过 |
| feedback 夹具 | 假 client 补 `flushPendingOutbox` | ✅ 15/15 通过 |
| context Assist | 按"**谁写了 context-graphs**"选 owner（实测 `scheduler~…` 只有 task-sequences，图在 `worker~…` 下） | ✅ 2/2 通过 |
| model-binding / zip | **单独跑均通过**；并行满载时偶发失败（既有 flaky，未改） | ⚠️ 见下 |

**全量复跑**：

```powershell
npx vitest run tests/core                     # 并行：约 2 条 flaky 失败（每次不同）
npx vitest run tests/core --maxWorkers=2      # 低并发：467 files / 3541 tests 全部通过
```

**结论**：这 7 条失败**全部是测试夹具/owner 选择/并行 flakiness**，没有一条是产品缺陷，
也没有一条由 R61–R66 的改动引入。**稳定的验收命令是 `--maxWorkers=2`**（仓库已有
`npm run check:low-parallel` 封装）。

## 7. 默认并行 flaky 处理（R68/R69，同日）

根因四类：①固定 20ms 等待；②外部进程/大模块导入超默认 5s；③崩溃夹具的 MODULE_NOT_FOUND 栈噪音；
④**清理竞态**——`orchestrator-git-integration` 直接删临时目录，而 task-chain 原子写仍在飞 ⇒
`rename` ENOENT 成为 unhandled rejection，污染无关用例。

修复（测试侧）：轮询替代固定等待、外部进程与 CLI 导入加超时、崩溃夹具改静默 `process.exit(1)`、
`afterEach` 先 `cancel()` 调度器再删目录。详见 [ADR-0135](../adr/0135-parallel-flakiness.md)。

**验证**：`npx vitest run tests/core` 默认并行**连续 3 次全绿**（467 files / 3541 tests，约 38s/次）；
修复前连续 4 次中 3 次失败。
