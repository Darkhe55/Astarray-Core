# 迁往私有 UI 仓库的变异体清单（2026-10-19）

依据：用户 2026-10-19 决策 —— **只有 CLI 落在公开库，TUI 与 GUI 统一放私有库**。
下列变异体的 `targetFile` 或 `testFiles` 指向已移出公开库的 UI 文件，
因此从公开 harness（`scripts/verify-mutation-kills.mjs`）移除；**私有库需要重建同名守卫**，
否则这些行为的「拔线必失败」证据在公开侧失效。

被移除条目数：**9**

| # | mutationIdentifier |
| --- | --- |
| 1 | `gui0203-history-reads-all-missions` |
| 2 | `gui0203-history-terminal-may-run` |
| 3 | `gui0203-history-corruption-dropped` |
| 4 | `gui0203-history-blank-project-faked` |
| 5 | `gui0203-views-runtime-state-collapsed` |
| 6 | `gui0203-views-missing-field-blank` |
| 7 | `memory-observation-source-replaced-by-owner` |
| 8 | `scope-dedicated-flow-relaxed` |
| 9 | `argument-fingerprint-ignores-values` |


## 后续（2026-10-19 R46）

私有库已建立 `npm run verify:mutation-kills`（`scripts/verify-mutation-kills.mjs`），
并针对**当前实现**重建了 3 条等价守卫（不逐条复原上表：原 find/replace 已随公开库改动失效）：

| 重建变异体 | 守住的行为 |
| --- | --- |
| `gui-serve-drops-permission-ask-registration` | `gui serve` 必须传 `onPermissionAskWithIdentity` |
| `gui-serve-unbinds-original-method` | 覆盖 `listPendingInstallationInquiries` 前必须 `.bind(application)` |
| `gui-cli-accepts-invalid-port` | 非法端口必须在解析期被拒（exit 2） |

剩余 6 条（GUI-02-03 视图类）尚无等价守卫 —— 那些行为需先在私有库补齐对应用例。
