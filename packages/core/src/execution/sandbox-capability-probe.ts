/**
 * EXEC-01-02（2026-11-09）：**沙箱资源清单与能力探测**。
 *
 * 本文件只做"证明能力是否真的可用"，不打包、不下载、不启动进程：
 * - 清单逐项校验存在性、SHA256、平台/架构匹配；
 * - 探测按"平台 → 清单项 → 完整性 → 版本"顺序进行，不可用时给出**具体原因**；
 * - 任何情况下都不返回模糊的 `isAvailable: true`：缺组件、哈希不符、平台未支持
 *   都必须是"不可用 + 原因"，由调用方阻断执行（卡内 §02：不支持则阻断，
 *   不得把失败说成"可选功能"）。
 */
import { createHash } from "node:crypto";

import type { SandboxCapabilityProfile } from "./process-execution-controller.js";

export type SandboxComponentIdentifier = "sandbox-helper" | "node-runtime";

export interface SandboxResourceManifestEntry {
  /** Node 的 `process.platform` 取值，例如 `win32` / `linux` / `darwin`。 */
  readonly platform: string;
  /** `process.arch` 取值，例如 `x64` / `arm64`。 */
  readonly architecture: string;
  readonly componentIdentifier: SandboxComponentIdentifier;
  /** 版本必须固定（不接受 "latest" 之类浮动值）。 */
  readonly componentVersion: string;
  /** 交付物内容哈希（小写十六进制，不带前缀）。 */
  readonly sha256: string;
  readonly sourceDescription: string;
  readonly licenseIdentifier: string;
  /** 例如 `windows-10.1809`。 */
  readonly minimumSystemRequirement: string;
}

/** 资源清单：必须覆盖声明支持的每个平台/架构。 */
export interface SandboxResourceManifest {
  readonly manifestVersion: number;
  readonly entries: readonly SandboxResourceManifestEntry[];
}

export type SandboxManifestFailureCode =
  | "manifest-empty"
  | "platform-not-supported"
  | "architecture-not-supported"
  | "component-missing"
  | "component-unreadable"
  | "integrity-mismatch"
  | "version-not-pinned";

export interface SandboxManifestVerificationFailure {
  readonly failureCode: SandboxManifestFailureCode;
  readonly detail: string;
  readonly platform: string;
  readonly architecture: string;
  readonly componentIdentifier: SandboxComponentIdentifier | null;
}

export interface SandboxManifestVerificationOutcome {
  readonly isVerified: boolean;
  readonly failures: readonly SandboxManifestVerificationFailure[];
}

/** 探测所需的文件访问端口（测试可注入，避免真实 I/O）。 */
export interface SandboxProbeFileSystem {
  /** 解析组件路径；不存在返回 null（不抛错）。 */
  resolveComponentPath(input: {
    readonly componentIdentifier: SandboxComponentIdentifier;
    readonly platform: string;
    readonly architecture: string;
    readonly componentVersion: string;
  }): Promise<string | null>;
  /** 读取组件字节；不可读返回 null。 */
  readComponentBytes(componentPath: string): Promise<Buffer | null>;
}

const PINNED_VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]*$/u;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

function computeSha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 校验清单本身（形状与版本固定），再逐项校验交付物。
 *
 * 顺序刻意如此：先证明"清单声明了什么"，再证明"声明的东西真的在且没被改过"。
 */
export async function verifySandboxResourceManifest(input: {
  readonly manifest: SandboxResourceManifest;
  readonly platform: string;
  readonly architecture: string;
  readonly fileSystem: SandboxProbeFileSystem;
}): Promise<SandboxManifestVerificationOutcome> {
  const failures: SandboxManifestVerificationFailure[] = [];
  const entries = input.manifest.entries;
  if (entries.length === 0) {
    return {
      isVerified: false,
      failures: [
        {
          failureCode: "manifest-empty",
          detail: "资源清单为空：不得据此声明任何平台可用",
          platform: input.platform,
          architecture: input.architecture,
          componentIdentifier: null,
        },
      ],
    };
  }

  for (const entry of entries) {
    if (!PINNED_VERSION_PATTERN.test(entry.componentVersion)) {
      failures.push({
        failureCode: "version-not-pinned",
        detail: `组件版本未固定：${entry.componentVersion}`,
        platform: entry.platform,
        architecture: entry.architecture,
        componentIdentifier: entry.componentIdentifier,
      });
      continue;
    }
    if (!SHA256_HEX_PATTERN.test(entry.sha256)) {
      failures.push({
        failureCode: "integrity-mismatch",
        detail: `清单登记的不是 64 位小写十六进制 SHA256：${entry.sha256}`,
        platform: entry.platform,
        architecture: entry.architecture,
        componentIdentifier: entry.componentIdentifier,
      });
      continue;
    }
    const componentPath = await input.fileSystem.resolveComponentPath({
      componentIdentifier: entry.componentIdentifier,
      platform: entry.platform,
      architecture: entry.architecture,
      componentVersion: entry.componentVersion,
    });
    if (componentPath === null) {
      failures.push({
        failureCode: "component-missing",
        detail: `清单声明的组件不存在：${entry.componentIdentifier}@${entry.componentVersion}`,
        platform: entry.platform,
        architecture: entry.architecture,
        componentIdentifier: entry.componentIdentifier,
      });
      continue;
    }
    const bytes = await input.fileSystem.readComponentBytes(componentPath);
    if (bytes === null) {
      failures.push({
        failureCode: "component-unreadable",
        detail: `组件不可读：${componentPath}`,
        platform: entry.platform,
        architecture: entry.architecture,
        componentIdentifier: entry.componentIdentifier,
      });
      continue;
    }
    const actualSha256 = computeSha256Hex(bytes);
    if (actualSha256 !== entry.sha256) {
      failures.push({
        failureCode: "integrity-mismatch",
        detail: `组件内容哈希不符：期望 ${entry.sha256}，实际 ${actualSha256}`,
        platform: entry.platform,
        architecture: entry.architecture,
        componentIdentifier: entry.componentIdentifier,
      });
    }
  }

  return { isVerified: failures.length === 0, failures };
}

/**
 * 探测当前平台是否有**真实可用**的沙箱后端。
 *
 * 返回的 `isAvailable` 只有在"清单校验通过且两个组件都在"时才为 true。
 * 任何失败都带具体原因码，供 CLI/GUI 分诊展示（卡内 §02 要求"启动前逐项探测能力"）。
 */
export async function probeSandboxCapability(input: {
  readonly manifest: SandboxResourceManifest;
  readonly platform: string;
  readonly architecture: string;
  readonly fileSystem: SandboxProbeFileSystem;
}): Promise<SandboxCapabilityProfile> {
  const platformEntries = input.manifest.entries.filter(
    (entry) => entry.platform === input.platform,
  );
  if (platformEntries.length === 0) {
    return {
      isAvailable: false,
      backendIdentifier: `manifest:${String(input.manifest.manifestVersion)}`,
      isolationPrimitiveDescription: "无",
      reasonUnavailable: `平台未支持：清单没有 ${input.platform} 条目（不得用其它平台的实现冒充）`,
    };
  }
  const architectureEntries = platformEntries.filter(
    (entry) => entry.architecture === input.architecture,
  );
  if (architectureEntries.length === 0) {
    return {
      isAvailable: false,
      backendIdentifier: `manifest:${String(input.manifest.manifestVersion)}`,
      isolationPrimitiveDescription: "无",
      reasonUnavailable: `架构未支持：${input.platform} 清单没有 ${input.architecture} 条目`,
    };
  }
  const requiredComponents: SandboxComponentIdentifier[] = [
    "sandbox-helper",
    "node-runtime",
  ];
  for (const componentIdentifier of requiredComponents) {
    if (
      !architectureEntries.some(
        (entry) => entry.componentIdentifier === componentIdentifier,
      )
    ) {
      return {
        isAvailable: false,
        backendIdentifier: `manifest:${String(input.manifest.manifestVersion)}`,
        isolationPrimitiveDescription: "无",
        reasonUnavailable: `清单缺少必需组件：${componentIdentifier}（基础执行能力不完整）`,
      };
    }
  }

  const verification = await verifySandboxResourceManifest({
    manifest: { manifestVersion: input.manifest.manifestVersion, entries: architectureEntries },
    platform: input.platform,
    architecture: input.architecture,
    fileSystem: input.fileSystem,
  });
  if (!verification.isVerified) {
    const firstFailure = verification.failures[0];
    return {
      isAvailable: false,
      backendIdentifier: `manifest:${String(input.manifest.manifestVersion)}`,
      isolationPrimitiveDescription: "无",
      reasonUnavailable:
        `资源清单校验失败（${String(firstFailure?.failureCode ?? "unknown")}）：` +
        String(firstFailure?.detail ?? "未知原因") +
        (verification.failures.length > 1
          ? `；另有 ${String(verification.failures.length - 1)} 项失败`
          : ""),
    };
  }

  const helperVersion =
    architectureEntries.find((entry) => entry.componentIdentifier === "sandbox-helper")
      ?.componentVersion ?? "unknown";
  return {
    isAvailable: true,
    backendIdentifier: `sandbox-helper:${helperVersion}`,
    isolationPrimitiveDescription:
      "由清单登记的沙箱辅助程序提供隔离（具体原语见平台实现清单文档）",
    reasonUnavailable: null,
  };
}
