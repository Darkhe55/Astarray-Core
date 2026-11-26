/**
 * AXIOMATIC-DESIGN P5（2026-11-26）：**解耦 import 规则**（可测试的纯逻辑 + 文件收集）。
 *
 * 规则：
 * 1. `public-sdk-facets/*` 不得反向 import 门面（`public-sdk.js`）或应用层（`../application/`）；
 * 2. 已抽出的 orchestration 服务/适配器不得 import 应用层（`../application/`）、
 *    门面（`public-sdk.js`）或控制器（`main-controller.js`）；
 * 3. 规则本身不联网、不改文件，只读文本。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 已抽出的独立模块：它们必须保持"单向依赖"（不得回指应用层/门面/控制器）。 */
export const EXTRACTED_ORCHESTRATION_MODULES = [
  "mission-completion-decision.ts",
  "permission-resolution.ts",
  "permission-overview.ts",
  "permission-resolution-service.ts",
  "goal-dispatch-gate-adapter.ts",
];

const FORBIDDEN_FOR_ORCHESTRATION = [
  /(^|\/)application\//,
  /(^|\/)public-sdk\.js$/,
  /(^|\/)main-controller\.js$/,
];

const FORBIDDEN_FOR_FACETS = [/(^|\/)public-sdk\.js$/, /(^|\/)application\//];

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\b[^'"`]*?from\s*["']([^"']+)["']/g;
/** 纯副作用 import（无 from 子句）。 */
const SIDE_EFFECT_IMPORT_PATTERN = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** 提取一个 TS 文件里的 import/export-from 说明符（去重、保序）。 */
export function collectImportSpecifiers(source) {
  const specifiers = [];
  for (const pattern of [IMPORT_PATTERN, SIDE_EFFECT_IMPORT_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (typeof specifier === "string" && !specifiers.includes(specifier)) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/**
 * 规则检查：输入 `{ relativePath, source }[]`，输出违规列表。
 * 违规 = `{ path, specifier, rule }`。
 */
export function findImportViolations(files) {
  const violations = [];
  for (const file of files) {
    const normalized = file.relativePath.split(path.sep).join("/");
    const specifiers = collectImportSpecifiers(file.source);

    if (normalized.startsWith("packages/core/src/public-sdk-facets/")) {
      for (const specifier of specifiers) {
        if (FORBIDDEN_FOR_FACETS.some((pattern) => pattern.test(specifier))) {
          violations.push({
            path: normalized,
            specifier,
            rule: "facets-must-not-import-facade-or-app-layer",
          });
        }
      }
      continue;
    }

    const baseName = path.posix.basename(normalized);
    if (
      normalized.startsWith("packages/core/src/orchestration/") &&
      EXTRACTED_ORCHESTRATION_MODULES.includes(baseName)
    ) {
      for (const specifier of specifiers) {
        if (FORBIDDEN_FOR_ORCHESTRATION.some((pattern) => pattern.test(specifier))) {
          violations.push({
            path: normalized,
            specifier,
            rule: "extracted-orchestration-must-not-import-upward",
          });
        }
      }
    }
  }
  return violations;
}

/** 递归收集目录下所有 .ts 文件（跳过 .test.ts / node_modules）。 */
export async function collectTsFiles(rootDirectory, relativeBase = "") {
  const entries = await fs.readdir(path.join(rootDirectory, relativeBase), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeBase.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...(await collectTsFiles(rootDirectory, relativePath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const source = await fs.readFile(path.join(rootDirectory, relativePath), "utf8");
    files.push({ relativePath, source });
  }
  return files;
}

/** 解耦指标（供设计矩阵报告引用）。 */
export async function collectDecouplingMetrics(rootDirectory) {
  const targets = {
    "packages/core/src/orchestration/main-controller.ts": null,
    "packages/core/src/public-sdk.ts": null,
  };
  const metrics = {};
  for (const [relativePath] of Object.entries(targets)) {
    const source = await fs.readFile(path.join(rootDirectory, relativePath), "utf8");
    metrics[relativePath] = {
      lineCount: source.split("\n").length,
      importCount: collectImportSpecifiers(source).length,
    };
  }
  const facetsDirectory = path.join(rootDirectory, "packages/core/src/public-sdk-facets");
  const facetNames = (await fs.readdir(facetsDirectory)).filter((name) => name.endsWith(".ts"));
  metrics.facets = facetNames.sort();
  return metrics;
}

/** 子门面已覆盖的方法名（CLI 必须经由 facade.<facet>.* 调用，不得直接调用整门面）。 */
export const FACET_COVERED_METHOD_NAMES = [
  // goal
  "activateGoalMode",
  "getGoalModeActivation",
  "proposeGoalContract",
  "confirmGoalContract",
  "createGoalContract",
  "bindMissionToGoal",
  "unbindMissionFromGoal",
  "describeGoalStatus",
  "deactivateGoal",
  "closeGoalExperiment",
  "bindRequirementTaskMapping",
  "invalidateGoalEvidence",
  // permission
  "listPermissionToolOverview",
  "previewToolPermission",
  "queryPermissionToolOverview",
  "queryParameterAuthorizationSettings",
  "queryParameterAuthorizationRuleDetails",
  "updateParameterAuthorizationSettings",
  "updateParameterAuthorizationRules",
  // ops
  "queryStartupRecoveryState",
  "queryExperimentCatalog",
  "queryArtifacts",
  "queryMissionArtifacts",
  // context
  "queryContextSettings",
  "updateContextBudget",
  // mission
  "queryMissionStatus",
  "queryMissionTaskSequence",
  "queryMission",
  "queryMissionRawStatus",
  "queryTask",
  "submitTask",
  "cancelTask",
];

const FACET_BYPASS_PATTERN = new RegExp(
  "\\bapplication\\.(" + FACET_COVERED_METHOD_NAMES.join("|") + ")\\(",
);

/**
 * CLI 绕过子门面的检查：输入 `{ relativePath, source }[]`（packages/tui/src 下）。
 * 违规 = `application.<facet 方法>(...)` 直接调用。
 */
export function findFacadeBypassViolations(files) {
  const violations = [];
  for (const file of files) {
    const normalized = file.relativePath.split(path.sep).join("/");
    if (!normalized.startsWith("packages/tui/src/")) continue;
    const lines = file.source.split("\n");
    for (const [index, line] of lines.entries()) {
      const match = FACET_BYPASS_PATTERN.exec(line);
      if (match === null) continue;
      violations.push({
        path: normalized,
        line: index + 1,
        methodName: match[1],
        rule: "cli-must-use-facet-getters",
      });
    }
  }
  return violations;
}
