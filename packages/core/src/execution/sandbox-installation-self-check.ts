/**
 * 安装后自检报告（EXEC-01-02 §02 本地可验证部分；2026-11-14）。
 *
 * 卡内要求（原文要点）："安装后自动注册内置环境并运行无副作用自检"；
 * "异常时其它产品功能继续运行并明确提示修复；但在声明支持的干净系统上基础执行不可用，
 * 属于发布阻塞，**不能以正常降级结案**"。
 *
 * 本文件是**纯聚合**：把"清单校验结论 + 后端能力探测结论"变成一份可展示的自检报告，
 * 不下载、不启动进程、不写盘（无副作用、可重复）。
 *
 * 关键纪律：**没有"未知但放行"这条路径**——
 * 只要不是"全部就绪"，`isExecutionAllowed` 必须为 false，并给出可执行的原因与下一步。
 */
import type {
  SandboxManifestVerificationFailure,
  SandboxManifestVerificationOutcome,
} from "./sandbox-capability-probe.js";
import type { SandboxCapabilityProfile } from "./process-execution-controller.js";

export type SandboxSelfCheckStatus =
  /** 清单校验通过且后端可用 ⇒ 允许执行。 */
  | "ready"
  /** 该平台/架构未交付 ⇒ 不可执行，且**不是**"可选功能缺失"。 */
  | "unsupported"
  /** 组件损坏/哈希不符 ⇒ 产品内可修复，未修复前不可执行。 */
  | "repair-required"
  /** 清单或探测本身失败（配置错误）⇒ 不可执行。 */
  | "failed";

export interface SandboxSelfCheckComponent {
  readonly componentIdentifier: string;
  readonly status: "ok" | "missing" | "damaged" | "not-applicable";
  readonly detail: string;
}

export interface SandboxSelfCheckReport {
  readonly status: SandboxSelfCheckStatus;
  /** 唯一真正允许执行的判据：`status === "ready"`。 */
  readonly isExecutionAllowed: boolean;
  readonly reasons: readonly string[];
  readonly components: readonly SandboxSelfCheckComponent[];
  /** 给用户/装配层的下一步（修复入口或平台说明）。 */
  readonly nextActionText: string;
}

const INTEGRITY_FAILURE_CODES = new Set(["integrity-mismatch", "component-unreadable"]);
const UNSUPPORTED_FAILURE_CODES = new Set(["platform-not-supported", "architecture-not-supported"]);

function componentStatusOf(
  failure: SandboxManifestVerificationFailure,
): SandboxSelfCheckComponent["status"] {
  if (INTEGRITY_FAILURE_CODES.has(failure.failureCode)) {
    return "damaged";
  }
  if (failure.failureCode === "component-missing") {
    return "missing";
  }
  return "not-applicable";
}

/**
 * 生成自检报告。
 *
 * 判定顺序刻意固定：**清单先于后端**——清单都没校验通过时说"后端可用"没有意义。
 */
export function buildSandboxSelfCheckReport(input: {
  readonly manifestVerification: SandboxManifestVerificationOutcome;
  readonly capabilityProfile: SandboxCapabilityProfile;
}): SandboxSelfCheckReport {
  const reasons: string[] = [];
  const failures = input.manifestVerification.failures;

  if (!input.manifestVerification.isVerified) {
    const hasUnsupportedPlatformFailure = failures.some((failure) =>
      UNSUPPORTED_FAILURE_CODES.has(failure.failureCode),
    );
    const hasRepairableFailure = failures.some((failure) =>
      INTEGRITY_FAILURE_CODES.has(failure.failureCode),
    );
    for (const failure of failures) {
      reasons.push(`${failure.failureCode}: ${failure.detail}`);
    }
    const status: SandboxSelfCheckStatus = hasUnsupportedPlatformFailure
      ? "unsupported"
      : hasRepairableFailure
        ? "repair-required"
        : "failed";
    return {
      status,
      isExecutionAllowed: false,
      reasons,
      components: failures.map((failure) => ({
        componentIdentifier: failure.componentIdentifier ?? "manifest",
        status: componentStatusOf(failure),
        detail: failure.detail,
      })),
      nextActionText:
        status === "unsupported"
          ? "当前系统/架构未交付基础执行能力：请改用受支持平台（该平台记为未达交付要求，不按可选功能对待）。"
          : status === "repair-required"
            ? "内置执行组件已损坏：请使用产品内修复入口重新校验/修复，修复前不执行任何任务。"
            : "自检失败：请检查安装包内置资源清单与装配配置。",
    };
  }

  if (!input.capabilityProfile.isAvailable) {
    reasons.push(input.capabilityProfile.reasonUnavailable ?? "后端能力探测报告不可用");
    return {
      status: "failed",
      isExecutionAllowed: false,
      reasons,
      components: [],
      nextActionText:
        "隔离后端不可用：基础执行被阻断（已确认不回退到宿主无限制执行）。请按提示修复或改用受支持平台。",
    };
  }

  return {
    status: "ready",
    isExecutionAllowed: true,
    reasons: [],
    components: [],
    nextActionText: `隔离后端就绪（${input.capabilityProfile.backendIdentifier}）：${input.capabilityProfile.isolationPrimitiveDescription}`,
  };
}
