/**
 * B9（2026-11-25）：作用域授权判定矩阵（deny 优先、模式/范围/安装开关的组合）。
 *
 * 纪律：deny 一律优先；思索模式非只读一律拒绝；安装开关关闭时**不得**被自动批准替代。
 */
import { describe, expect, it } from "vitest";

import {
  decideScopeAuthorization,
  isValidEscalationPath,
} from "../../../packages/core/src/tools/scope-resolution.js";
import type { AgentLevel, ScopeClass } from "../../../packages/core/src/tools/scope-resolution.js";

function decide(overrides: Partial<Parameters<typeof decideScopeAuthorization>[0]> = {}) {
  return decideScopeAuthorization({
    scopeClass: "S3-project-external",
    mode: "assist",
    configuredDecision: "ask",
    isInstallationEnabled: false,
    isReadOnlyOperation: false,
    ...overrides,
  });
}

describe("B9：作用域授权判定矩阵", () => {
  it("① deny 一律优先（含放权模式与只读操作）", () => {
    const outcome = decide({
      configuredDecision: "deny",
      mode: "devolve",
      isReadOnlyOperation: true,
      scopeClass: "S5-installation",
    });
    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons.join("")).toContain("deny");
  });

  it("② 思索模式：只读 ⇒ allow；非只读 ⇒ deny（不受配置决策影响）", () => {
    expect(
      decide({ mode: "ponder", isReadOnlyOperation: true, configuredDecision: "allow" }).decision,
    ).toBe("allow");
    expect(
      decide({ mode: "ponder", isReadOnlyOperation: false, configuredDecision: "allow" }).decision,
    ).toBe("deny");
  });

  it("③ 专用流程 S7 ⇒ ask-user（不由本模块放宽）", () => {
    const outcome = decide({ scopeClass: "S7-special-flow" as ScopeClass, configuredDecision: "allow" });
    expect(outcome.decision).toBe("ask-user");
    expect(outcome.adjudicator).toBe("dedicated-flow");
  });

  it("④ 安装范围 S5：开关关闭 ⇒ deny 且要求安装开关；协同 ⇒ ask-user；放权按配置", () => {
    const disabled = decide({
      scopeClass: "S5-installation" as ScopeClass,
      isInstallationEnabled: false,
    });
    expect(disabled.decision).toBe("deny");
    expect(disabled.requiresInstallationSwitch).toBe(true);

    const assist = decide({
      scopeClass: "S5-installation" as ScopeClass,
      isInstallationEnabled: true,
      mode: "assist",
    });
    expect(assist.decision).toBe("ask-user");

    const devolveAsk = decide({
      scopeClass: "S5-installation" as ScopeClass,
      isInstallationEnabled: true,
      mode: "devolve",
      configuredDecision: "ask",
    });
    expect(devolveAsk.decision).toBe("ask-superior");

    const devolveAllow = decide({
      scopeClass: "S5-installation" as ScopeClass,
      isInstallationEnabled: true,
      mode: "devolve",
      configuredDecision: "allow",
    });
    expect(devolveAllow.decision).toBe("allow");
  });

  it("⑤ 项目内受控安装（S1 + 安装操作）：开关关闭 ⇒ deny；开启后按模式与配置", () => {
    const base = {
      scopeClass: "S1-project-internal" as ScopeClass,
      operationKind: "dependency-install" as const,
    };
    expect(decide({ ...base, isInstallationEnabled: false }).decision).toBe("deny");

    const assistAllow = decide({
      ...base,
      isInstallationEnabled: true,
      mode: "assist",
      configuredDecision: "allow",
    });
    expect(assistAllow.decision).toBe("allow");
    expect(assistAllow.adjudicator).toBe("superior-agent");

    const assistAsk = decide({
      ...base,
      isInstallationEnabled: true,
      mode: "assist",
      configuredDecision: "ask",
    });
    expect(assistAsk.decision).toBe("ask-superior");

    const devolveAsk = decide({
      ...base,
      isInstallationEnabled: true,
      mode: "devolve",
      configuredDecision: "ask",
    });
    expect(devolveAsk.decision).toBe("ask-superior");
  });

  it("⑥ 升级路径：必须逐级向上、以次级收尾、不超过 3 层且无重复", () => {
    const path = (...levels: AgentLevel[]) => levels;
    expect(isValidEscalationPath(path("secondary"))).toBe(true);
    expect(isValidEscalationPath(path("tertiary", "secondary"))).toBe(true);
    expect(isValidEscalationPath(path("quaternary", "tertiary", "secondary"))).toBe(true);

    expect(isValidEscalationPath([])).toBe(false);
    expect(isValidEscalationPath(path("tertiary"))).toBe(false);
    expect(isValidEscalationPath(path("secondary", "tertiary"))).toBe(false);
    /** 允许跨级（只要求深度严格递减且以 secondary 收尾）。 */
    expect(isValidEscalationPath(path("quaternary", "secondary"))).toBe(true);
    expect(isValidEscalationPath(path("quaternary", "tertiary", "secondary", "secondary" as never))).toBe(false);
  });
});
