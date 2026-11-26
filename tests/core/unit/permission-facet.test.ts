/**
 * AXIOMATIC-DESIGN P2（2026-11-26）：权限域子门面的独立契约。
 *
 * 子门面只依赖窄宿主（controller 两个查询入口 + 参数授权设置存储 + assertOpen），
 * 因此可用假宿主单测，不再需要构造 8540 行门面或真实运行时。
 */
import { describe, expect, it, vi } from "vitest";

import { PermissionFacet } from "../../../packages/core/src/public-sdk-facets/permission-facet.js";

function buildHost(overrides: Record<string, unknown> = {}) {
  const assertOpen = vi.fn();
  const listPermissionToolOverview = vi.fn(async () => [
    {
      toolName: "readFile",
      isActionOnly: false,
      capabilityIds: ["read-project"],
      actions: [{ action: "read", capabilityIds: ["read-project"] }],
      baselineDecision: "allow" as const,
      baselineSource: "profile-capabilities" as const,
      isRegistered: true,
      isExecutable: true,
    },
  ]);
  const previewToolPermission = vi.fn(async (input: { toolName: string; action: string }) => ({
    decision: "allow" as const,
    toolName: input.toolName,
    action: input.action,
  }));
  const readSettings = vi.fn(async () => ({
    schemaVersion: "v1",
    settings: {
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      perToolRulesEnabled: { readFile: true },
    },
    rules: [
      {
        ruleIdentifier: "rule-1",
        toolName: "readFile",
        action: "read",
        decision: "allow" as const,
        explanation: "示例",
        match: { kind: "path-prefix", field: "path", prefix: "docs/" },
      },
    ],
    configurationRevision: 7,
  }));
  const host = {
    permissionController: { listPermissionToolOverview, previewToolPermission },
    assertOpen,
    createParameterAuthorizationSettingsStore: () => ({ readSettings }) as never,
    ...overrides,
  };
  return { host: host as never, assertOpen, listPermissionToolOverview, previewToolPermission, readSettings };
}

describe("AXIOMATIC P2：权限域子门面", () => {
  it("① list / query 概览：转发 controller 且先 assertOpen", async () => {
    const { host, assertOpen, listPermissionToolOverview } = buildHost();
    const facet = new PermissionFacet(host);

    const list = await facet.listPermissionToolOverview();
    expect(list).toHaveLength(1);
    expect(listPermissionToolOverview).toHaveBeenCalledTimes(1);

    const overview = await facet.queryPermissionToolOverview();
    expect(overview).toHaveLength(1);
    expect(listPermissionToolOverview).toHaveBeenCalledTimes(2);
    expect(assertOpen).toHaveBeenCalledTimes(2);
  });

  it("② previewToolPermission：参数原样透传，不自行裁决", async () => {
    const { host, previewToolPermission } = buildHost();
    const facet = new PermissionFacet(host);
    const outcome = await facet.previewToolPermission({ toolName: "readFile", action: "read" });
    expect(previewToolPermission).toHaveBeenCalledWith({ toolName: "readFile", action: "read" });
    expect(outcome).toMatchObject({ decision: "allow", toolName: "readFile" });
  });

  it("③ 规则明细：字段逐一映射，缺省 perTool 返回空对象，revision 保留", async () => {
    const { host, readSettings } = buildHost();
    const facet = new PermissionFacet(host);
    const details = await facet.queryParameterAuthorizationRuleDetails();
    expect(details).toMatchObject({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      perToolRulesEnabled: { readFile: true },
      configurationRevision: 7,
    });
    expect(details.rules).toHaveLength(1);
    expect(readSettings).toHaveBeenCalledTimes(1);

    const { host: hostNoPerTool } = buildHost({
      createParameterAuthorizationSettingsStore: () => ({
        readSettings: async () => ({
          settings: {
            isParameterAuthorizationEnabled: true,
            isParameterRulesEnabled: true,
          },
          rules: [],
          configurationRevision: 0,
        }),
      }),
    });
    const empty = await new PermissionFacet(hostNoPerTool).queryParameterAuthorizationRuleDetails();
    expect(empty.perToolRulesEnabled).toEqual({});
  });

  it("④ assertOpen 抛错 ⇒ 子门面不越过关闭态（不调用 controller）", async () => {
    const { host, listPermissionToolOverview } = buildHost({
      assertOpen: () => {
        throw new Error("application-closed");
      },
    });
    const facet = new PermissionFacet(host);
    await expect(facet.listPermissionToolOverview()).rejects.toThrow("application-closed");
    expect(listPermissionToolOverview).not.toHaveBeenCalled();
  });
});
