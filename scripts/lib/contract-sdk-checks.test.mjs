/**
 * 契约层 SDK 包级验收判定的单测（`npm run test:scripts`）。
 *
 * 目的：证明判定**不会**在"缺观测/观测为空/判据太少"时放行（防空转）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_CONTRACT_SDK_CHECK_COUNT,
  buildContractSdkChecks,
} from "./contract-sdk-checks.mjs";

/** 全项通过的观测（与 scenario 输出结构一致）。 */
function acceptedObservation() {
  return {
    crossProject: { agentFilteredReceiptCount: 1, unfilteredReceiptCount: 2 },
    folder: {
      ancestorClassification: "ancestor-of-project-root",
      isDefaultApproved: false,
      isBatch: false,
    },
    workWindow: { outsideWhitelistState: "resting" },
    docView: { unknownModeIsNull: true, writeBackAllowed: false },
    configChat: {
      secretReasonCode: "secret-setting-requires-protected-entry",
      awaitingIsApplied: false,
    },
    onboarding: { neverShowAgainOutcome: "suppress" },
    fold: {
      selfVerificationReasonCode: "author-verified-own-work",
      rollbackReasonCode: "unknown-side-effects",
      autoRerunOldWorkflow: false,
    },
    explore: { realDataReasonCode: "real-user-data-forbidden", restoredMaximumTrials: 0 },
    curate: { secondLockKind: "already-running", coalescedRunCount: 1 },
    history: { sanitizedChanged: true, containsEscape: false, evidenceAnchor: "run-history:mission-1#7" },
  };
}

test("全项观测满足 ⇒ 接受，且判据数不低于下限", () => {
  const result = buildContractSdkChecks(acceptedObservation());
  assert.equal(result.isAccepted, true, result.summary);
  assert.ok(result.totalCount >= MINIMUM_CONTRACT_SDK_CHECK_COUNT);
  assert.equal(result.passedCount, result.totalCount);
});

test("缺一段观测 ⇒ 拒绝（不得因没测到而放行）", () => {
  const observation = acceptedObservation();
  delete observation.explore;
  const result = buildContractSdkChecks(observation);
  assert.equal(result.isAccepted, false);
  const failedNames = result.checks.filter((check) => !check.passed).map((check) => check.name);
  assert.ok(failedNames.some((name) => name.includes("explore")));
});

test("观测为空对象 ⇒ 拒绝且判据数低于下限", () => {
  const result = buildContractSdkChecks({});
  assert.equal(result.isAccepted, false);
  assert.equal(result.passedCount, 0);
});

test("单项被改成满足不了的值 ⇒ 拒绝并点名该判据", () => {
  const observation = acceptedObservation();
  observation.curate = { secondLockKind: "acquired", coalescedRunCount: 3 };
  const result = buildContractSdkChecks(observation);
  assert.equal(result.isAccepted, false);
  const failedNames = result.checks.filter((check) => !check.passed).map((check) => check.name);
  assert.ok(failedNames.some((name) => name.includes("already-running") || name.includes("单实例")));
  assert.ok(failedNames.some((name) => name.includes("合并")));
});

test("观测不是对象 ⇒ 拒绝（不抛错、不放行）", () => {
  for (const badObservation of [null, undefined, 42, "text"]) {
    const result = buildContractSdkChecks(badObservation);
    assert.equal(result.isAccepted, false);
  }
});
