/**
 * AXIOMATIC-DESIGN P3（2026-11-26）：工具权限概览装配的反例。
 */
import { describe, expect, it } from "vitest";

import { buildPermissionToolOverview } from "../../../packages/core/src/orchestration/permission-overview.js";

const catalog = {
  listToolMappings: () => [
    { toolName: "readFile", capabilityIds: ["cap-read"] },
    { toolName: "mappedOnly", capabilityIds: ["cap-write"] },
  ],
  listToolActionMappings: () => [
    { toolName: "processExecution", actions: { start: ["cap-exec"], status: ["cap-read"] } },
  ],
};

const registry = {
  listRegisteredNames: () => ["readFile", "processExecution", "registryOnly"],
  isRegistered: (toolName: string) => toolName !== "mappedOnly",
};

describe("AXIOMATIC P3：工具权限概览装配", () => {
  it("① 缺能力目录 ⇒ 空数组（不伪造工具）", () => {
    expect(
      buildPermissionToolOverview({ profile: null, capabilityCatalog: null, registry }),
    ).toEqual([]);
    expect(
      buildPermissionToolOverview({ profile: null, capabilityCatalog: undefined, registry }),
    ).toEqual([]);
  });

  it("② 目录与注册表并集、按名称排序；纯动作工具标记 isActionOnly", () => {
    const overview = buildPermissionToolOverview({
      profile: {
        capabilityDecisions: {},
        toolDecisions: {},
        fallbackDecision: "allow",
      },
      capabilityCatalog: catalog,
      registry,
    });
    expect(overview.map((entry) => entry.toolName)).toEqual([
      "mappedOnly",
      "processExecution",
      "readFile",
      "registryOnly",
    ]);
    const actionOnly = overview.find((entry) => entry.toolName === "processExecution");
    expect(actionOnly?.isActionOnly).toBe(true);
    expect(actionOnly?.actions.map((entry) => entry.action)).toEqual(["start", "status"]);
    const normal = overview.find((entry) => entry.toolName === "readFile");
    expect(normal?.isActionOnly).toBe(false);
  });

  it("③ 无权限组 ⇒ baselineDecision=null 且来源 unknown（不猜）", () => {
    const overview = buildPermissionToolOverview({
      profile: null,
      capabilityCatalog: catalog,
      registry,
    });
    expect(overview.every((entry) => entry.baselineDecision === null)).toBe(true);
    expect(overview.every((entry) => entry.baselineSource === "unknown")).toBe(true);
  });

  it("④ 基线按最严规则聚合：能力 deny ⇒ deny；显式工具决定覆盖聚合", () => {
    const overview = buildPermissionToolOverview({
      profile: {
        capabilityDecisions: { "cap-read": "allow", "cap-write": "deny" },
        toolDecisions: { registryOnly: "deny" },
        fallbackDecision: "allow",
      },
      capabilityCatalog: catalog,
      registry,
    });
    expect(overview.find((entry) => entry.toolName === "readFile")?.baselineDecision).toBe("allow");
    expect(overview.find((entry) => entry.toolName === "mappedOnly")?.baselineDecision).toBe("deny");
    expect(overview.find((entry) => entry.toolName === "registryOnly")?.baselineDecision).toBe(
      "deny",
    );
    expect(
      overview.every((entry) => entry.baselineSource === "profile-capabilities"),
    ).toBe(true);
  });

  it("⑤ 目录已映射但未注册 ⇒ isRegistered/isExecutable 都为 false（如实标注）", () => {
    const overview = buildPermissionToolOverview({
      profile: null,
      capabilityCatalog: catalog,
      registry,
    });
    const mappedOnly = overview.find((entry) => entry.toolName === "mappedOnly");
    expect(mappedOnly?.isRegistered).toBe(false);
    expect(mappedOnly?.isExecutable).toBe(false);
    const registered = overview.find((entry) => entry.toolName === "readFile");
    expect(registered?.isRegistered).toBe(true);
    expect(registered?.isExecutable).toBe(true);
  });
});
