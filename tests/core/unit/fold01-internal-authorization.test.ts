/**
 * 折叠包内部逐步授权的反例（2026-10-20 R106）。
 *
 * 核心：不得越权、不可逆动作必须步步确认、未知能力拒绝、被拒即整包阻塞。
 */
import { describe, expect, it } from "vitest";

import { evaluateFoldPackageAuthorization } from "../../../packages/core/src/orchestration/workflow-fold-internal-authorization.js";

const scope = (...capabilities: string[]) => new Set(capabilities);
const granted = (...capabilities: string[]) => new Set(capabilities);

describe("折叠包内部逐步授权", () => {
  it("① 能力不在登记范围 ⇒ deny 并**整包阻塞**（不是再问一次）", () => {
    const report = evaluateFoldPackageAuthorization({
      steps: [{ stepIdentifier: "step-1", requiredCapabilities: ["fs-write"] }],
      declaredCapabilityScope: scope("fs-read"),
      grantedCapabilitiesInRun: granted("fs-write"),
    });
    expect(report.isPackageRunBlocked).toBe(true);
    expect(report.blockedAtStepIdentifier).toBe("step-1");
    expect(report.decisions[0]).toMatchObject({ kind: "deny", reasonCode: "outside-declared-scope" });
  });

  it("② 未知能力 ⇒ deny（不认识就不猜）", () => {
    const report = evaluateFoldPackageAuthorization({
      steps: [{ stepIdentifier: "step-1", requiredCapabilities: ["registry-write"] }],
      declaredCapabilityScope: scope("registry-write"),
      grantedCapabilitiesInRun: granted(),
    });
    expect(report.decisions[0]).toMatchObject({ kind: "deny", reasonCode: "unknown-capability" });
    expect(report.isPackageRunBlocked).toBe(true);
  });

  it("③ 可逆能力未批准 ⇒ ask-step（不直接执行）", () => {
    const report = evaluateFoldPackageAuthorization({
      steps: [{ stepIdentifier: "step-1", requiredCapabilities: ["fs-write"] }],
      declaredCapabilityScope: scope("fs-write"),
      grantedCapabilitiesInRun: granted(),
    });
    expect(report.decisions[0]).toMatchObject({ kind: "ask-step", isIrreversible: false });
    expect(report.requiresStepwisePrompts).toBe(true);
  });

  it("④ 可逆能力已在本次运行批准 ⇒ allow 且标记复用（不反复弹窗）", () => {
    const report = evaluateFoldPackageAuthorization({
      steps: [{ stepIdentifier: "step-1", requiredCapabilities: ["fs-write"] }],
      declaredCapabilityScope: scope("fs-write"),
      grantedCapabilitiesInRun: granted("fs-write"),
    });
    expect(report.decisions[0]).toMatchObject({ kind: "allow", isReusedGrant: true });
    expect(report.isPackageRunBlocked).toBe(false);
  });

  it("⑤ 不可逆能力即使已批准、在范围内，也必须**逐步确认**（且不跨 run 持久化）", () => {
    for (const irreversibleCapability of ["fs-delete", "shell-exec"]) {
      const report = evaluateFoldPackageAuthorization({
        steps: [{ stepIdentifier: "step-1", requiredCapabilities: [irreversibleCapability] }],
        declaredCapabilityScope: scope(irreversibleCapability),
        grantedCapabilitiesInRun: granted(irreversibleCapability),
      });
      expect(report.decisions[0], irreversibleCapability).toMatchObject({
        kind: "ask-step",
        isIrreversible: true,
      });
      expect(report.isIrreversibleGrantPersistent).toBe(false);
    }
  });

  it("⑥ 一步被拒 ⇒ 后续步骤不再判定（不「先做点别的」）", () => {
    const report = evaluateFoldPackageAuthorization({
      steps: [
        { stepIdentifier: "step-1", requiredCapabilities: ["shell-exec"] },
        { stepIdentifier: "step-2", requiredCapabilities: ["fs-delete"] },
      ],
      declaredCapabilityScope: scope("fs-read"),
      grantedCapabilitiesInRun: granted(),
    });
    expect(report.isPackageRunBlocked).toBe(true);
    expect(report.blockedAtStepIdentifier).toBe("step-1");
    // 只有第一步的判定存在（第一步被 deny 后即停）
    expect(report.decisions).toHaveLength(1);
  });

  it("⑦ 多能力步骤：任一需询问即整步询问（不能「部分执行」）", () => {
    const report = evaluateFoldPackageAuthorization({
      steps: [
        {
          stepIdentifier: "step-1",
          requiredCapabilities: ["fs-read", "shell-exec"],
        },
      ],
      declaredCapabilityScope: scope("fs-read", "shell-exec"),
      grantedCapabilitiesInRun: granted("fs-read"),
    });
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]).toMatchObject({ kind: "ask-step", isIrreversible: true });
  });
});

