import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/tui/src/**/*.ts", "packages/tui/src/**/*.tsx"],
      exclude: [
        "packages/tui/src/cli.tsx",
        "私有 TUI 包（已迁出）/**",
        "私有 GUI 包（已迁出）/**",
        "packages/core/src/feedback-process/child-bootstrap.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85,
      },
    },
  },
});
