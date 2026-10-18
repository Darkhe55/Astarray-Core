import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
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
