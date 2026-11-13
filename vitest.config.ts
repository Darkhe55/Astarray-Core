import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    /**
     * 只排除**已过期**的那一个外部用例文件，不整目录排除。
     *
     * `UI 测试（已迁出）/integration/gui02-04-package-entry.test.ts` 的验收前提是「GUI 必须有
     * 公开包入口」，而 2026-10-18 的分层决策（提交 `0cf91b24`）**刻意移除了** GUI 的
     * `exports` 出口 ⇒ 该用例的前提已不成立，保留在门禁里会让公开仓库恒红。
     * 外部用例文件本身不改（权威副本在 UI 仓库），由 UI 仓库决定其去留。
     *
     * **为什么不整目录排除 `UI 测试（已迁出）/**`**：`verify:mutation-kills` 里有 6 条变异体
     * 由 `UI 测试（已迁出）` 的 GUI-02-03 历史视图用例守卫；整目录排除会让它们全部变成「存活」。
     *
     * 注：`coverage.exclude` 只影响覆盖率统计、**不会**把文件排除出测试收集
     * （分层提交 `d3f01be6` 只改了 `coverage.exclude`，故当时门禁仍在跑外部用例）。
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "UI 测试（已迁出）/integration/gui02-04-package-entry.test.ts",
    ],
    environment: "node",
    /**
     * 测试临时目录卫生：**开跑前**清扫超过 24h 的历史残骸，**跑完**回收本次运行新建、
     * 却因用例没写清理 / 断言失败 / worker 被 SIGKILL 而留下的目录。
     *
     * 只处理 `os.tmpdir()` 下 `astarray-` 前缀的目录；基线内与其它目录一概不动。
     */
    globalSetup: ["tests/global-setup/index.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/tui/src/**/*.ts", "packages/tui/src/**/*.tsx"],
      exclude: [
        /** 仓库分层（2026-10-18）：UI 测试（已迁出） 属外部部分。 */
        "UI 测试（已迁出）/**",
        "packages/tui/src/cli.tsx",
        "TUI 包（已迁出）/**",
        "UI 包（已迁出）/**",
        "packages/core/src/feedback-process/child-bootstrap.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85,
      },
    },
  },
});
