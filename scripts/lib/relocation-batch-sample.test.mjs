/**
 * RELOCATE 批量对账（脱敏样例）判定逻辑的单测：证明判定不会在缺观测时放行。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_RELOCATION_BATCH_CHECK_COUNT,
  buildRelocationBatchChecks,
  buildSanitizedRelocationSample,
  summarizeReconciliation,
} from "./relocation-batch-sample.mjs";

function acceptedObservation() {
  return {
    isSanitized: true,
    projects: [
      {
        projectIdentifier: "alpha",
        kind: "reconciled",
        isAutoResumeAllowed: true,
        resolvedReferenceCount: 2,
        rewrittenReferenceCount: 1,
        rewrittenReferencePaths: ["/sample/projects/alpha-old/docs/spec.md"],
        unresolvedReferenceCodes: [],
        pendingDecisionKinds: ["may-retry", "skip-already-completed"],
        pendingRejectionCodes: [],
      },
      {
        projectIdentifier: "beta",
        kind: "blocked",
        isExecutionAllowed: false,
        unresolvedReferenceCodes: ["unsupported-resource-kind", "foreign-device"],
        pendingRejectionCodes: ["unknown-side-effect"],
      },
      {
        projectIdentifier: "gamma",
        kind: "blocked",
        unresolvedReferenceCodes: ["ambiguous-mapping"],
        pendingRejectionCodes: ["stale-grant-not-restored"],
      },
      {
        projectIdentifier: "delta",
        kind: "blocked",
        unresolvedReferenceCodes: ["outside-old-root"],
        pendingRejectionCodes: [],
      },
    ],
  };
}

test("全项满足 ⇒ 接受，且判据数不低于下限", () => {
  const result = buildRelocationBatchChecks(acceptedObservation());
  assert.equal(result.isAccepted, true, result.summary);
  assert.ok(result.totalCount >= MINIMUM_RELOCATION_BATCH_CHECK_COUNT);
});

test("缺一个项目 ⇒ 拒绝并点名", () => {
  const observation = acceptedObservation();
  observation.projects = observation.projects.filter((project) => project.projectIdentifier !== "delta");
  const result = buildRelocationBatchChecks(observation);
  assert.equal(result.isAccepted, false);
  const failed = result.checks.filter((check) => !check.passed).map((check) => check.name);
  assert.ok(failed.some((name) => name.includes("4 个项目")));
  assert.ok(failed.some((name) => name.includes("逃逸")));
});

test("alpha 被改成 blocked ⇒ 拒绝", () => {
  const observation = acceptedObservation();
  observation.projects[0].kind = "blocked";
  observation.projects[0].isAutoResumeAllowed = false;
  const result = buildRelocationBatchChecks(observation);
  assert.equal(result.isAccepted, false);
});

test("未标记脱敏 ⇒ 拒绝", () => {
  const observation = acceptedObservation();
  observation.isSanitized = false;
  assert.equal(buildRelocationBatchChecks(observation).isAccepted, false);
});

test("观测不是对象 ⇒ 拒绝（不抛错）", () => {
  for (const badObservation of [null, undefined, 42, "text"]) {
    assert.equal(buildRelocationBatchChecks(badObservation).isAccepted, false);
  }
});

test("summarizeReconciliation 只暴露稳定代码与计数（不含原始路径内容以外的细节）", () => {
  const summary = summarizeReconciliation("alpha", {
    kind: "reconciled",
    isAutoResumeAllowed: true,
    isExecutionAllowed: true,
    resolvedReferences: [
      { requestedPath: "a", resolvedPath: "b", wasRewritten: true },
      { requestedPath: "c", resolvedPath: "d", wasRewritten: false },
    ],
    unresolvedReferences: [],
    pendingOperationDecisions: [
      { operationIdentifier: "op", decisionKind: "may-retry", rejectionCode: null },
    ],
    requiredUserAction: "只读恢复对账：路径已解析且无阻塞，可直接继续。",
  });
  assert.equal(summary.rewrittenReferenceCount, 1);
  assert.deepEqual(summary.pendingRejectionCodes, []);
  assert.equal(summary.projectIdentifier, "alpha");
});

test("脱敏样例本身：3 个项目、路径全部在 /sample 下、无用户目录痕迹", () => {
  const sample = buildSanitizedRelocationSample();
  assert.equal(sample.isSanitized, true);
  assert.equal(sample.projects.length, 4);
  const serialized = JSON.stringify(sample);
  assert.ok(!/Users[\\/]|Documents[\\/]|AppData/.test(serialized), "样例不得含本机路径痕迹");
  assert.ok(serialized.includes("/sample/projects/"));
});

