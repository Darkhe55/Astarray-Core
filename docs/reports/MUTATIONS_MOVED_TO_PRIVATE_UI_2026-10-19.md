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
