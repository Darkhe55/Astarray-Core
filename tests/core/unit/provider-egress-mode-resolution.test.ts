/**
 * RELEASE-01-02（2026-11-23）：Provider 出口扫描**策略解析**的反例。
 *
 * 生产缺省必须是 block；旧配置的 record/off 只能在"明确隔离诊断"下生效，
 * 否则必须报冲突并回落 block（fail-closed），禁止静默沿用弱化档位。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_EGRESS_SCAN_MODE,
  resolveProviderEgressScanMode,
} from "../../../packages/core/src/runtime/provider-egress-scan.js";

describe("RELEASE-01-02：出口扫描策略解析", () => {
  it("① 缺省/空值 ⇒ block，无冲突", () => {
    expect(resolveProviderEgressScanMode({})).toEqual({
      mode: DEFAULT_PROVIDER_EGRESS_SCAN_MODE,
      conflictReason: null,
    });
    expect(resolveProviderEgressScanMode({ configuredMode: "  " }).mode).toBe("block");
  });

  it("② 显式 block ⇒ block，无冲突", () => {
    expect(resolveProviderEgressScanMode({ configuredMode: "block" })).toEqual({
      mode: "block",
      conflictReason: null,
    });
  });

  it("③ 旧生产配置 record ⇒ 报冲突并回落 block", () => {
    const resolution = resolveProviderEgressScanMode({ configuredMode: "record" });
    expect(resolution.mode).toBe("block");
    expect(resolution.conflictReason).toContain("旧配置使用 record");
    expect(resolution.conflictReason).toContain("回落 block");
  });

  it("④ 旧生产配置 off ⇒ 同样拒绝（不静默放行）", () => {
    const resolution = resolveProviderEgressScanMode({ configuredMode: "off" });
    expect(resolution.mode).toBe("block");
    expect(resolution.conflictReason).toContain("旧配置使用 off");
  });

  it("⑤ 明确隔离诊断 ⇒ 允许 record/off（仅此路径）", () => {
    expect(
      resolveProviderEgressScanMode({ configuredMode: "record", isIsolatedDiagnostic: true }),
    ).toEqual({ mode: "record", conflictReason: null });
    expect(
      resolveProviderEgressScanMode({ configuredMode: "off", isIsolatedDiagnostic: true }),
    ).toEqual({ mode: "off", conflictReason: null });
  });

  it("⑥ 未知值 ⇒ 冲突 + 回落 block（fail-closed）", () => {
    const resolution = resolveProviderEgressScanMode({ configuredMode: "record-all" });
    expect(resolution.mode).toBe("block");
    expect(resolution.conflictReason).toContain("未知的出口扫描档位");
  });
});
