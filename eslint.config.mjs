import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      ".tmp/",
      ".astarray/",
      "scripts/",
      "tests/fixtures/",
          /** 仓库分层（2026-10-18）：以下属私有/本地 UI，公开仓库不含。 */
          "packages/tui/src/ui/",
          "packages/tui/src/cli/tui.tsx",
          "packages/gui/",
          "tests/gui/",
      ".verify-*/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
