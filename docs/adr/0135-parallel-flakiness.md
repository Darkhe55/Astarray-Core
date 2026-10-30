# ADR-0135 默认并行下的 flaky 处理（R68/R69，2026-10-30）

- 状态：已采纳（测试侧加固；**默认并行连续 3 次全绿**）
- 来源：用户要求处理默认并行下的 flaky
- 相关：[FULL_SUITE_BASELINE_2026-10-30](../reports/FULL_SUITE_BASELINE_2026-10-30.md)

## 1. 现象

`npx vitest run tests/core`（默认并行）偶发失败，**每次失败的用例不同**：
`model-binding`、`tool-package-zip`、`usage/perf overview`、`event01-event-source`、
`public-sdk`，并伴随 `Errors 1–2 errors`（unhandled rejection）。
低并发 `--maxWorkers=2` 则稳定全绿 —— 说明是**测试并发/隔离**问题，不是产品逻辑。

## 2. 根因（实测证据）

1. **固定等待**：`model-binding` 提交任务后固定等 20ms 就断言 runtime 已解析模型，
   满载时 mission 还没创建 runtime ⇒ 偶发失败。
2. **外部进程/大模块导入 vs 默认 5s 超时**：`tool-package-zip` 要启动 `powershell.exe` 生成 zip；
   `usage/perf overview` 动态 `import` 整个 CLI 命令模块。满载冷启动都可能 >5s。
3. **崩溃夹具噪音**：`feedback-supervisor` 用 `non-existent-entry.js` 触发重启，
   子进程在模块解析阶段把整段 Node 栈写到 stderr，满载时被 vitest 记为 unhandled error。
4. **清理竞态（最关键的污染源）**：`orchestrator-git-integration` 的 `afterEach` **直接删临时目录**，
   而 mission 收口时的 `task-chain` 原子写仍在飞行 ⇒ `rename` 抛 `ENOENT`
   （`atomic-json.ts` 栈），被记为 unhandled rejection，**把无关用例标红**
   （日志里的 `mission-git-session-failure` 即证据）。

## 3. 修复（全部测试侧，未改产品代码）

| 文件 | 修复 |
|---|---|
| `model-binding-runtime-switch.test.ts` | 固定 20ms 等待 → **轮询可观察结果**（上限 10s）；断言未放宽 |
| `tool-package-zip-installer.test.ts` | `spawnSync` 加 60s 上限；两个用例 `60_000` 超时 |
| `usage-overview-query.test.ts` / `perf-overview-command.test.ts` | ⑦ 用例 `30_000` 超时（动态导入 CLI 模块） |
| `feedback-supervisor.test.ts` | 用**临时崩溃模块**（`process.exit(1)`，静默）替代 `non-existent-entry.js` |
| `orchestrator-git-integration.test.ts` | 记录创建的调度器；`afterEach` **先 `cancel()` 再删目录** |

## 4. 验证（真实运行）

```powershell
npx vitest run tests/core    # 默认并行，连续 3 次
```

| 轮次 | 结果 | 耗时 |
|---|---|---|
| 1 | 467 files / 3541 tests 全通过 | 37.9s |
| 2 | 467 files / 3541 tests 全通过 | 37.6s |
| 3 | 467 files / 3541 tests 全通过 | 37.8s |

修复前同一命令连续 4 次中 3 次失败（不同用例 + unhandled errors）。

## 5. 未完成（如实）

- **未证明"永不 flaky"**：3 次连续全绿是强证据，不是数学保证；
- **未根除所有 unhandled 风险**：其他测试若也在清理时留下在飞写，仍可能复现同类问题；
- **未改产品代码**：`atomic-json` 在"目录被删后 rename"仍会抛错（调用方需自行处理）；
- **未接入 CI**：没有自动多次复跑机制，建议后续在 CI 里至少跑 2 次默认并行。

## 6. 状态

测试侧修复完成并已验证；默认并行可作为日常门禁，`--maxWorkers=2` 仍是更稳的兜底。
