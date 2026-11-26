/**
 * AXIOMATIC-DESIGN P3（2026-11-26）：工具基线权限解析（纯函数）的反例矩阵。
 *
 * 规则来自既有控制器实现，抽取时逐字保留：
 * - 无权限组 ⇒ null（未知，不猜）；
 * - 无能力映射 ⇒ 显式工具决定（可空）；
 * - 有能力映射 ⇒ deny 立即胜出；ask 降级聚合；**显式工具决定覆盖聚合值**；
 * - 能力缺省取 fallbackDecision。
 */
import { describe, expect, it } from "vitest";

import { resolveToolBaselineDecision } from "../../../packages/core/src/orchestration/permission-resolution.js";

const allowProfile = {
  capabilityDecisions: { "cap-read": "allow" as const, "cap-write": "allow" as const },
  toolDecisions: {},
  fallbackDecision: "allow" as const,
};

describe("AXIOMATIC P3：工具基线权限解析", () => {
  it("① 没有权限组 ⇒ null（不猜）", () => {
    expect(resolveToolBaselineDecision(null, ["cap-read"], "readFile")).toBeNull();
  });

  it("② 无能力映射：有显式工具决定 ⇒ 用显式；没有 ⇒ null", () => {
    expect(
      resolveToolBaselineDecision(
        { ...allowProfile, toolDecisions: { readFile: "deny" } },
        [],
        "readFile",
      ),
    ).toBe("deny");
    expect(resolveToolBaselineDecision(allowProfile, [], "readFile")).toBeNull();
  });

  it("③ 能力级 deny 立即胜出（覆盖显式 allow）", () => {
    const profile = {
      capabilityDecisions: { "cap-read": "deny" as const, "cap-write": "allow" as const },
      toolDecisions: { dangerousTool: "allow" as const },
      fallbackDecision: "allow" as const,
    };
    expect(resolveToolBaselineDecision(profile, ["cap-read", "cap-write"], "dangerousTool")).toBe(
      "deny",
    );
  });

  it("④ 能力级 ask 聚合为 ask；显式 allow 覆盖聚合 ask", () => {
    const askProfile = {
      capabilityDecisions: { "cap-write": "ask" as const },
      toolDecisions: {},
      fallbackDecision: "allow" as const,
    };
    expect(resolveToolBaselineDecision(askProfile, ["cap-write"], "writeFile")).toBe("ask");

    const explicitAllow = {
      capabilityDecisions: { "cap-write": "ask" as const },
      toolDecisions: { writeFile: "allow" as const },
      fallbackDecision: "allow" as const,
    };
    expect(resolveToolBaselineDecision(explicitAllow, ["cap-write"], "writeFile")).toBe("allow");
  });

  it("⑤ 能力缺省取 fallbackDecision：fallback=ask 且无映射项 ⇒ ask", () => {
    const profile = {
      capabilityDecisions: {},
      toolDecisions: {},
      fallbackDecision: "ask" as const,
    };
    expect(resolveToolBaselineDecision(profile, ["cap-unknown"], "tool-x")).toBe("ask");
  });

  it("⑥ 全部 allow 且显式 deny ⇒ deny（显式覆盖聚合）", () => {
    expect(
      resolveToolBaselineDecision(
        { ...allowProfile, toolDecisions: { writeFile: "deny" } },
        ["cap-read", "cap-write"],
        "writeFile",
      ),
    ).toBe("deny");
  });
});
