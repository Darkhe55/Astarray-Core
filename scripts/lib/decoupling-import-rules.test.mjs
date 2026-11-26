/**
 * AXIOMATIC-DESIGN P5（2026-11-26）：解耦 import 规则的反例。
 *
 * 反例优先：每类违规都先构造"应该报错"的输入；同时验证真实仓库当前为零违规。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectDecouplingMetrics,
  collectImportSpecifiers,
  findImportViolations,
} from "./decoupling-import-rules.mjs";

let temporaryDirectory;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-decoupling-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("解耦 import 规则", () => {
  it("① 提取 import/export-from 说明符（含多行 import）", () => {
    const source = `import { a } from "./a.js";\nimport type {\n  B,\n} from "../b.js";\nexport type { C } from "./c.js";\nimport "./side-effect.js";\n`;
    assert.deepEqual(collectImportSpecifiers(source), [
      "./a.js",
      "../b.js",
      "./c.js",
      "./side-effect.js",
    ]);
  });

  it("② 反例：facet 反向 import 门面 ⇒ 违规", () => {
    const violations = findImportViolations([
      {
        relativePath: "packages/core/src/public-sdk-facets/bad-facet.ts",
        source: 'import { AstarrayApplicationFacade } from "../public-sdk.js";\n',
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "facets-must-not-import-facade-or-app-layer");
  });

  it("③ 反例：facet import 应用层 ⇒ 违规", () => {
    const violations = findImportViolations([
      {
        relativePath: "packages/core/src/public-sdk-facets/bad-facet.ts",
        source: 'import type { AgentRuntime } from "../application/application-runtime.js";\n',
      },
    ]);
    assert.equal(violations.length, 1);
  });

  it("④ 反例：已抽出的 orchestration 服务回指控制器/门面/应用层 ⇒ 违规", () => {
    const violations = findImportViolations([
      {
        relativePath: "packages/core/src/orchestration/permission-resolution-service.ts",
        source: [
          'import { MainController } from "./main-controller.js";',
          'import { AstarrayApplicationFacade } from "../public-sdk.js";',
          'import type { X } from "../application/application-runtime.js";',
        ].join("\n"),
      },
    ]);
    assert.equal(violations.length, 3);
    assert.ok(
      violations.every(
        (violation) => violation.rule === "extracted-orchestration-must-not-import-upward",
      ),
    );
  });

  it("⑤ 合规样例不误报：facet 只 import 同层模块与 core", () => {
    const violations = findImportViolations([
      {
        relativePath: "packages/core/src/public-sdk-facets/mission-facet.ts",
        source: 'import type { MissionStatus } from "../orchestration/mission-manager.js";\n',
      },
      {
        relativePath: "packages/core/src/orchestration/permission-overview.ts",
        source: 'import { resolveToolBaselineDecision } from "./permission-resolution.js";\n',
      },
    ]);
    assert.deepEqual(violations, []);
  });

  it("⑥ 真实仓库当前零违规，且能给出解耦指标", async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
    const files = [];
    for (const directory of ["packages/core/src/public-sdk-facets", "packages/core/src/orchestration"]) {
      const absolute = path.join(repositoryRoot, directory);
      const entries = await fs.readdir(absolute);
      for (const entry of entries) {
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        files.push({
          relativePath: `${directory}/${entry}`,
          source: await fs.readFile(path.join(absolute, entry), "utf8"),
        });
      }
    }
    assert.deepEqual(findImportViolations(files), []);

    const metrics = await collectDecouplingMetrics(repositoryRoot);
    assert.ok(metrics["packages/core/src/public-sdk.ts"].lineCount > 0);
    assert.ok(metrics["packages/core/src/public-sdk.ts"].importCount > 0);
    assert.equal(metrics.facets.length, 5);
  });

  it("⑦ 临时目录：违规文件被识别（规则可独立于仓库运行）", async () => {
    const facetDirectory = path.join(
      temporaryDirectory,
      "packages/core/src/public-sdk-facets",
    );
    await fs.mkdir(facetDirectory, { recursive: true });
    await fs.writeFile(
      path.join(facetDirectory, "bad.ts"),
      'import { x } from "../public-sdk.js";\n',
      "utf8",
    );
    const files = await (await import("./decoupling-import-rules.mjs")).collectTsFiles(
      temporaryDirectory,
    );
    const violations = findImportViolations(files);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "packages/core/src/public-sdk-facets/bad.ts");
  });
});
