/**
 * EXEC-01-02（2026-11-09）：沙箱资源清单与能力探测的**反例优先**验证。
 *
 * 纪律：这里不验证"沙箱可用"（那需要真实辅助程序与干净设备，见 §06），
 * 只验证"不可用必须被如实报告，绝不返回模糊的可用"。
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  probeSandboxCapability,
  verifySandboxResourceManifest,
  type SandboxProbeFileSystem,
  type SandboxResourceManifest,
} from "../../../packages/core/src/execution/sandbox-capability-probe.js";

const helperBytes = Buffer.from("fake-helper-binary", "utf8");
const nodeBytes = Buffer.from("fake-node-binary", "utf8");

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildManifest(
  overrides: Partial<{
    platform: string;
    architecture: string;
    helperSha256: string;
    nodeSha256: string;
    helperVersion: string;
  }> = {},
): SandboxResourceManifest {
  const platform = overrides.platform ?? "win32";
  const architecture = overrides.architecture ?? "x64";
  return {
    manifestVersion: 1,
    entries: [
      {
        platform,
        architecture,
        componentIdentifier: "sandbox-helper",
        componentVersion: overrides.helperVersion ?? "1.0.0",
        sha256: overrides.helperSha256 ?? sha256Hex(helperBytes),
        sourceDescription: "自研构建流水线",
        licenseIdentifier: "LicenseRef-Astarray",
        minimumSystemRequirement: "windows-10.1809",
      },
      {
        platform,
        architecture,
        componentIdentifier: "node-runtime",
        componentVersion: "22.11.0",
        sha256: overrides.nodeSha256 ?? sha256Hex(nodeBytes),
        sourceDescription: "上游官方构建",
        licenseIdentifier: "MIT",
        minimumSystemRequirement: "windows-10.1809",
      },
    ],
  };
}

/** 内存文件系统：按组件标识返回字节；`missing` 中的组件返回 null。 */
function buildFileSystem(missing: string[] = []): SandboxProbeFileSystem {
  return {
    resolveComponentPath: async (input) =>
      missing.includes(input.componentIdentifier)
        ? null
        : `/product/sandbox/${input.componentIdentifier}-${input.componentVersion}`,
    readComponentBytes: async (componentPath) => {
      if (componentPath.includes("sandbox-helper")) return helperBytes;
      if (componentPath.includes("node-runtime")) return nodeBytes;
      return null;
    },
  };
}

describe("EXEC-01-02 资源清单校验", () => {
  it("清单与交付物一致 ⇒ 校验通过", async () => {
    const outcome = await verifySandboxResourceManifest({
      manifest: buildManifest(),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(outcome.isVerified).toBe(true);
    expect(outcome.failures).toEqual([]);
  });

  it("空清单不得声明任何平台可用", async () => {
    const outcome = await verifySandboxResourceManifest({
      manifest: { manifestVersion: 1, entries: [] },
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(outcome.isVerified).toBe(false);
    expect(outcome.failures[0]?.failureCode).toBe("manifest-empty");
  });

  it("组件缺失 ⇒ component-missing（不当作可用）", async () => {
    const outcome = await verifySandboxResourceManifest({
      manifest: buildManifest(),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(["sandbox-helper"]),
    });
    expect(outcome.isVerified).toBe(false);
    expect(outcome.failures.map((failure) => failure.failureCode)).toContain(
      "component-missing",
    );
  });

  it("哈希不符 ⇒ integrity-mismatch，且报告期望值与实际值", async () => {
    const outcome = await verifySandboxResourceManifest({
      manifest: buildManifest({ helperSha256: "0".repeat(64) }),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(outcome.isVerified).toBe(false);
    const failure = outcome.failures.find(
      (candidate) => candidate.failureCode === "integrity-mismatch",
    );
    expect(failure?.detail).toContain("期望");
    expect(failure?.detail).toContain("实际");
  });

  it("版本浮动（latest）⇒ version-not-pinned", async () => {
    const outcome = await verifySandboxResourceManifest({
      manifest: buildManifest({ helperVersion: "latest" }),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(outcome.isVerified).toBe(false);
    expect(outcome.failures.map((failure) => failure.failureCode)).toContain(
      "version-not-pinned",
    );
  });

  it("清单登记非法 SHA256 形状 ⇒ integrity-mismatch", async () => {
    const outcome = await verifySandboxResourceManifest({
      manifest: buildManifest({ nodeSha256: "NOT-A-HASH" }),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(outcome.isVerified).toBe(false);
    expect(outcome.failures.map((failure) => failure.failureCode)).toContain(
      "integrity-mismatch",
    );
  });
});

describe("EXEC-01-02 能力探测：不可用必须给出具体原因", () => {
  it("清单完整且校验通过 ⇒ 可用，并透出后端标识", async () => {
    const profile = await probeSandboxCapability({
      manifest: buildManifest(),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(profile.isAvailable).toBe(true);
    expect(profile.reasonUnavailable).toBeNull();
    expect(profile.backendIdentifier).toContain("sandbox-helper");
  });

  it("平台未支持 ⇒ 不可用且说明不得用其它平台冒充", async () => {
    const profile = await probeSandboxCapability({
      manifest: buildManifest({ platform: "linux" }),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(profile.isAvailable).toBe(false);
    expect(profile.reasonUnavailable).toContain("平台未支持");
  });

  it("架构未支持 ⇒ 不可用（同一平台不同架构不互相顶替）", async () => {
    const profile = await probeSandboxCapability({
      manifest: buildManifest({ architecture: "arm64" }),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(profile.isAvailable).toBe(false);
    expect(profile.reasonUnavailable).toContain("架构未支持");
  });

  it("缺必需组件 ⇒ 不可用且点名缺哪个", async () => {
    const manifest = buildManifest();
    const withoutNodeRuntime: SandboxResourceManifest = {
      manifestVersion: manifest.manifestVersion,
      entries: manifest.entries.filter(
        (entry) => entry.componentIdentifier !== "node-runtime",
      ),
    };
    const profile = await probeSandboxCapability({
      manifest: withoutNodeRuntime,
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(profile.isAvailable).toBe(false);
    expect(profile.reasonUnavailable).toContain("node-runtime");
  });

  it("哈希不符 ⇒ 不可用，原因含失败码与明细", async () => {
    const profile = await probeSandboxCapability({
      manifest: buildManifest({ helperSha256: "a".repeat(64) }),
      platform: "win32",
      architecture: "x64",
      fileSystem: buildFileSystem(),
    });
    expect(profile.isAvailable).toBe(false);
    expect(profile.reasonUnavailable).toContain("integrity-mismatch");
  });

  it("组件不可读 ⇒ 不可用（不把读失败当成通过）", async () => {
    const profile = await probeSandboxCapability({
      manifest: buildManifest(),
      platform: "win32",
      architecture: "x64",
      fileSystem: {
        resolveComponentPath: async () => "/product/sandbox/unknown",
        readComponentBytes: async () => null,
      },
    });
    expect(profile.isAvailable).toBe(false);
    expect(profile.reasonUnavailable).toContain("component-unreadable");
  });
});
