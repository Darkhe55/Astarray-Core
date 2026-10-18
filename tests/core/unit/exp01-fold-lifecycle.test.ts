/**
 * FOLD-01-03 的反例（2026-10-19 R27）：包复用、停用与回退。
 *
 * 卡内验收：回归可停用新版本；回退前确认无未知副作用；不自动重跑旧工作流；
 * 复用须版本与参数 schema 匹配。
 */
import { describe, expect, it } from "vitest";

import {
  buildFoldPackageRetirement,
  evaluateFoldPackageReuse,
  evaluateFoldRegressionResponse,
  planFoldPackageRollback,
} from "../../../packages/core/src/orchestration/workflow-fold-lifecycle.js";

const registered = [
  { toolIdentifier: "release-notes-tool", version: 1, bundleFingerprint: "fp-v1" },
  { toolIdentifier: "release-notes-tool", version: 2, bundleFingerprint: "fp-v2" },
];

describe("FOLD-01-03：复用、停用与回退", () => {
  it("① 已登记且参数一致 ⇒ 允许复用", () => {
    expect(
      evaluateFoldPackageReuse({
        toolIdentifier: "release-notes-tool",
        version: 2,
        registeredPackages: registered,
        retiredVersions: [],
        parameterNames: ["outputPath", "templatePath"],
        expectedParameterNames: ["outputPath", "templatePath"],
      }),
    ).toMatchObject({ kind: "allowed", version: 2 });
  });

  it("② 停用版本 / 未登记版本 ⇒ 拒绝复用", () => {
    expect(
      evaluateFoldPackageReuse({
        toolIdentifier: "release-notes-tool",
        version: 2,
        registeredPackages: registered,
        retiredVersions: [{ toolIdentifier: "release-notes-tool", version: 2 }],
        parameterNames: ["outputPath"],
        expectedParameterNames: ["outputPath"],
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "version-retired" });

    expect(
      evaluateFoldPackageReuse({
        toolIdentifier: "release-notes-tool",
        version: 9,
        registeredPackages: registered,
        retiredVersions: [],
        parameterNames: ["outputPath"],
        expectedParameterNames: ["outputPath"],
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "version-unknown" });
  });

  it("③ 参数多给/少给/空名 ⇒ 拒绝（防注入与漏传副作用目标）", () => {
    const base = {
      toolIdentifier: "release-notes-tool",
      version: 1,
      registeredPackages: registered,
      retiredVersions: [],
      expectedParameterNames: ["outputPath"],
    };
    expect(
      evaluateFoldPackageReuse({ ...base, parameterNames: ["outputPath", "extraInjection"] }),
    ).toMatchObject({ reasonCode: "parameter-schema-mismatch" });
    expect(evaluateFoldPackageReuse({ ...base, parameterNames: [] })).toMatchObject({
      reasonCode: "parameter-schema-mismatch",
    });
    expect(evaluateFoldPackageReuse({ ...base, parameterNames: [" "] })).toMatchObject({
      reasonCode: "missing-parameter-value",
    });
  });

  it("④ 回退：无未知副作用且无在途实例 ⇒ 允许；且不自动重跑", () => {
    const approved = planFoldPackageRollback({
      fromVersion: 2,
      toVersion: 1,
      isTargetVersionAvailable: true,
      hasUnknownSideEffects: false,
      inFlightInstanceCount: 0,
    });
    expect(approved).toMatchObject({ kind: "approved", fromVersion: 2, toVersion: 1 });
    expect(JSON.stringify(approved)).not.toContain("rerun");
  });

  it("⑤ 回退阻塞：未知副作用 / 在途实例 / 目标不可用 / 同版本", () => {
    const base = {
      fromVersion: 2,
      toVersion: 1,
      isTargetVersionAvailable: true,
      hasUnknownSideEffects: false,
      inFlightInstanceCount: 0,
    };
    expect(planFoldPackageRollback({ ...base, hasUnknownSideEffects: true })).toMatchObject({
      reasonCode: "unknown-side-effects",
    });
    expect(planFoldPackageRollback({ ...base, inFlightInstanceCount: 1 })).toMatchObject({
      reasonCode: "in-flight-instances",
    });
    expect(planFoldPackageRollback({ ...base, isTargetVersionAvailable: false })).toMatchObject({
      reasonCode: "target-version-unavailable",
    });
    expect(planFoldPackageRollback({ ...base, toVersion: 2 })).toMatchObject({
      reasonCode: "same-version",
    });
  });

  it("⑥ 发现回归 ⇒ 停用新版本，但**不自动重跑**旧工作流", () => {
    const response = evaluateFoldRegressionResponse({ hasRegression: true });
    expect(response.shouldRetireNewVersion).toBe(true);
    expect(response.shouldAutoRerunOldWorkflow).toBe(false);
    expect(response.reason).toContain("不自动重跑");
  });

  it("⑦ 停用必须记录原因，历史保留", () => {
    const retired = buildFoldPackageRetirement({
      toolIdentifier: "release-notes-tool",
      version: 2,
      reason: "输出与旧版不一致",
      affectedInstanceCount: 1,
      retiredAtIso: "2026-10-19T00:00:00.000Z",
    });
    expect(retired.kind).toBe("retired");
    if (retired.kind !== "retired") throw new Error("应停用");
    expect(retired.record.isHistoryRetained).toBe(true);
    expect(retired.record.affectedInstanceCount).toBe(1);

    expect(
      buildFoldPackageRetirement({
        toolIdentifier: "release-notes-tool",
        version: 2,
        reason: "  ",
        affectedInstanceCount: 0,
        retiredAtIso: "2026-10-19T00:00:00.000Z",
      }).kind,
    ).toBe("rejected");
  });
});
