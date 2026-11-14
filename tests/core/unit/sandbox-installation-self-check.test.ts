/**
 * 安装后自检报告（2026-11-14，新模块；EXEC-01-02 §02 本地可验证部分）。
 *
 * 这是"不能以正常降级结案"的落点：只有全部就绪才允许执行；
 * 平台未交付 / 组件损坏 / 探测失败必须**分类给出**，不能糊成一句"不可用"后静默放过。
 */
import { describe, expect, it } from "vitest";

import { buildSandboxSelfCheckReport } from "../../../packages/core/src/execution/sandbox-installation-self-check.js";
import type {
  SandboxManifestVerificationFailure,
  SandboxManifestVerificationOutcome,
} from "../../../packages/core/src/execution/sandbox-capability-probe.js";
import type { SandboxCapabilityProfile } from "../../../packages/core/src/execution/process-execution-controller.js";

const AVAILABLE_PROFILE: SandboxCapabilityProfile = {
  isAvailable: true,
  backendIdentifier: "helper-appcontainer",
  isolationPrimitiveDescription: "AppContainer 低权限容器",
  reasonUnavailable: null,
} as SandboxCapabilityProfile;

const UNAVAILABLE_PROFILE: SandboxCapabilityProfile = {
  isAvailable: false,
  backendIdentifier: "none",
  isolationPrimitiveDescription: "未装配隔离后端",
  reasonUnavailable: "未装配沙箱执行后端：拒绝执行（不降级到宿主进程执行）",
} as SandboxCapabilityProfile;

function verified(): SandboxManifestVerificationOutcome {
  return { isVerified: true, failures: [] };
}

function withFailures(
  failures: readonly SandboxManifestVerificationFailure[],
): SandboxManifestVerificationOutcome {
  return { isVerified: false, failures };
}

function failure(
  failureCode: SandboxManifestVerificationFailure["failureCode"],
  componentIdentifier: SandboxManifestVerificationFailure["componentIdentifier"] = "sandbox-helper",
): SandboxManifestVerificationFailure {
  return {
    failureCode,
    detail: `模拟失败：${failureCode}`,
    platform: "win32",
    architecture: "x64",
    componentIdentifier,
  };
}

describe("安装后自检报告", () => {
  it("① 清单通过 + 后端可用 ⇒ ready，且允许执行", () => {
    const report = buildSandboxSelfCheckReport({
      manifestVerification: verified(),
      capabilityProfile: AVAILABLE_PROFILE,
    });
    expect(report.status).toBe("ready");
    expect(report.isExecutionAllowed).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.nextActionText).toContain("helper-appcontainer");
  });

  it("② 清单通过但后端不可用 ⇒ failed，**不允许执行**（不回退宿主）", () => {
    const report = buildSandboxSelfCheckReport({
      manifestVerification: verified(),
      capabilityProfile: UNAVAILABLE_PROFILE,
    });
    expect(report.status).toBe("failed");
    expect(report.isExecutionAllowed).toBe(false);
    expect(report.reasons.join("|")).toContain("拒绝执行");
    expect(report.nextActionText).toContain("不回退");
  });

  it("③ 平台/架构未交付 ⇒ unsupported（不是'可选功能缺失'）", () => {
    const report = buildSandboxSelfCheckReport({
      manifestVerification: withFailures([failure("platform-not-supported", null)]),
      capabilityProfile: AVAILABLE_PROFILE,
    });
    expect(report.status).toBe("unsupported");
    expect(report.isExecutionAllowed).toBe(false);
    expect(report.nextActionText).toContain("未达交付要求");
  });

  it("④ 组件损坏/不可读 ⇒ repair-required（产品内可修）", () => {
    const report = buildSandboxSelfCheckReport({
      manifestVerification: withFailures([failure("integrity-mismatch")]),
      capabilityProfile: AVAILABLE_PROFILE,
    });
    expect(report.status).toBe("repair-required");
    expect(report.isExecutionAllowed).toBe(false);
    expect(report.components[0]?.status).toBe("damaged");
    expect(report.nextActionText).toContain("修复入口");
  });

  it("⑤ 组件缺失 ⇒ 归为 failed 并标 missing；清单空 ⇒ failed", () => {
    const missing = buildSandboxSelfCheckReport({
      manifestVerification: withFailures([failure("component-missing")]),
      capabilityProfile: AVAILABLE_PROFILE,
    });
    expect(missing.status).toBe("failed");
    expect(missing.components[0]?.status).toBe("missing");

    const empty = buildSandboxSelfCheckReport({
      manifestVerification: withFailures([failure("manifest-empty", null)]),
      capabilityProfile: AVAILABLE_PROFILE,
    });
    expect(empty.status).toBe("failed");
    expect(empty.isExecutionAllowed).toBe(false);
  });

  it("⑥ 清单失败**优先于**后端结论：清单不通过时不得因后端可用而放行", () => {
    const report = buildSandboxSelfCheckReport({
      manifestVerification: withFailures([failure("version-not-pinned")]),
      capabilityProfile: AVAILABLE_PROFILE,
    });
    expect(report.isExecutionAllowed).toBe(false);
    expect(report.status).toBe("failed");
  });

  it("⑦ 任何非 ready 状态都不得允许执行（穷举）", () => {
    const cases = [
      withFailures([failure("platform-not-supported", null)]),
      withFailures([failure("integrity-mismatch")]),
      withFailures([failure("component-missing")]),
      withFailures([failure("manifest-empty", null)]),
    ];
    for (const manifestVerification of cases) {
      const report = buildSandboxSelfCheckReport({
        manifestVerification,
        capabilityProfile: AVAILABLE_PROFILE,
      });
      expect(report.isExecutionAllowed).toBe(false);
      expect(report.status).not.toBe("ready");
      expect(report.reasons.length).toBeGreaterThan(0);
    }
  });

  it("⑧ 纯函数且确定性：同输入两次报告完全一致（无副作用）", () => {
    const input = {
      manifestVerification: withFailures([failure("integrity-mismatch")]),
      capabilityProfile: AVAILABLE_PROFILE,
    };
    expect(buildSandboxSelfCheckReport(input)).toEqual(buildSandboxSelfCheckReport(input));
  });
});
