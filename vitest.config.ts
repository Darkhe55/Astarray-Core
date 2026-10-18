import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/tui/src/**/*.ts", "packages/tui/src/**/*.tsx"],
      exclude: [
        /** 仓库分层（2026-10-18）：tests/gui 属私有部分。 */
        "tests/gui/**",
        "packages/tui/src/cli.tsx",
        "packages/tui/src/ui/**",
        "packages/gui/**",
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
