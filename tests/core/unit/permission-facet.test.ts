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
  const previewToolPermission = vi.fn(async (_input: { toolName: string; action: string }) => ({
    status: "ok" as const,
    baselineDecision: "allow" as const,
    capabilityIds: ["read-project"],
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
    expect(outcome).toMatchObject({ status: "ok", baselineDecision: "allow", capabilityIds: ["read-project"] });
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

  it("⑤ 参数预览：非法 JSON / 非对象 / 未知工具 / 权限组不可读 四路如实返回", async () => {
    const { host } = buildHost();
    const facet = new PermissionFacet(host);
    expect((await facet.previewParameterAuthorization({ toolName: "readFile", action: "read", argumentsJson: "{bad" })).status).toBe("invalid-arguments");
    expect((await facet.previewParameterAuthorization({ toolName: "readFile", action: "read", argumentsJson: "[1]" })).status).toBe("invalid-arguments");
    const { host: unreadableHost } = buildHost({
      permissionController: {
        listPermissionToolOverview: async () => [],
        previewToolPermission: async () => ({ status: "ok", baselineDecision: null, capabilityIds: [] }),
      },
    });
    expect(
      (await new PermissionFacet(unreadableHost).previewParameterAuthorization({
        toolName: "readFile",
        action: "read",
        argumentsJson: "{}",
      })).status,
    ).toBe("preview-unavailable");

    const { host: unknownHost } = buildHost({
      permissionController: {
        listPermissionToolOverview: async () => [],
        previewToolPermission: async () => ({ status: "unknown-tool", baselineDecision: null, capabilityIds: [] }),
      },
    });
    const unknown = await new PermissionFacet(unknownHost).previewParameterAuthorization({
      toolName: "nope",
      action: "read",
      argumentsJson: "{}",
    });
    expect(unknown.status).toBe("unknown-tool");
  });

  it("⑥ 参数预览：总开关关闭 ⇒ 只按工具基线且标记规则跳过；开启 ⇒ 走规则判定", async () => {
    const disabledSettings = {
      createParameterAuthorizationSettingsStore: () => ({
        readSettings: async () => ({
          settings: { isParameterAuthorizationEnabled: false, isParameterRulesEnabled: true },
          rules: [],
          configurationRevision: 3,
        }),
      }),
    };
    const { host } = buildHost(disabledSettings);
    const disabled = await new PermissionFacet(host).previewParameterAuthorization({
      toolName: "readFile",
      action: "read",
      argumentsJson: "{}",
    });
    expect(disabled).toMatchObject({
      status: "ok",
      source: "tool-baseline",
      isRuleEvaluationSkipped: true,
      configurationRevision: 3,
    });

    const enabledSettings = {
      createParameterAuthorizationSettingsStore: () => ({
        readSettings: async () => ({
          settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
          rules: [],
          configurationRevision: 4,
        }),
      }),
    };
    const { host: enabledHost } = buildHost(enabledSettings);
    const enabled = await new PermissionFacet(enabledHost).previewParameterAuthorization({
      toolName: "readFile",
      action: "read",
      argumentsJson: "{}",
    });
    expect(enabled).toMatchObject({ status: "ok", configurationRevision: 4 });
  });

  it("⑦ 规则写入：revision 冲突拒绝；放宽未确认 ⇒ confirmation-required；确认后保存", async () => {
    const replaceDocument = vi.fn(async () => ({ configurationRevision: 8 }));
    const readSettings = vi.fn(async () => ({
      settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
      rules: [
        {
          ruleIdentifier: "rule-1",
          toolName: "readFile",
          action: "read",
          decision: "deny" as const,
          explanation: "旧",
          match: { kind: "path-prefix", field: "path", prefix: "docs/" },
        },
      ],
      configurationRevision: 7,
    }));
    const { host } = buildHost({
      createParameterAuthorizationSettingsStore: () => ({ readSettings, replaceDocument }) as never,
    });
    const facet = new PermissionFacet(host);

    const stale = await facet.updateParameterAuthorizationRules({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      rules: [],
      expectedRevision: 6,
      isConfirmedByAuthenticatedUser: false,
    });
    expect(stale.status).toBe("rejected");

    const widenedRule = {
      ruleIdentifier: "rule-1",
      toolName: "readFile",
      action: "read",
      decision: "allow" as const,
      explanation: "放宽",
      match: { kind: "path-prefix" as const, field: "path", prefix: "docs/" },
    };
    const needsConfirm = await facet.updateParameterAuthorizationRules({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      rules: [widenedRule],
      expectedRevision: 7,
      isConfirmedByAuthenticatedUser: false,
    });
    expect(needsConfirm.status).toBe("confirmation-required");
    expect(needsConfirm.widenedRules).toContain("rule-1");

    const saved = await facet.updateParameterAuthorizationRules({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      rules: [widenedRule],
      expectedRevision: 7,
      isConfirmedByAuthenticatedUser: true,
    });
    expect(saved.status).toBe("saved");
    expect(replaceDocument).toHaveBeenCalledTimes(1);
  });

  it("⑧ 设置写入：不接受的变更不落盘；接受后写入且拒绝时抛宿主错误", async () => {
    const writeSettings = vi.fn(async () => ({ isValid: true, reason: null }));
    const { host } = buildHost({
      createParameterAuthorizationSettingsStore: () =>
        ({
          readSettings: async () => ({
            settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
            rules: [],
            configurationRevision: 1,
          }),
          writeSettings,
        }) as never,
    });
    const facet = new PermissionFacet(host);

    /** 工具形态为空 ⇒ 无放宽，直接接受并写入。 */
    const change = await facet.updateParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      toolAuthorizationShapes: [],
      isConfirmedByAuthenticatedUser: false,
    });
    expect(change.isAccepted).toBe(true);
    expect(writeSettings).toHaveBeenCalledTimes(1);

    const failingHost = buildHost({
      createParameterAuthorizationSettingsStore: () =>
        ({
          readSettings: async () => ({
            settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
            rules: [],
            configurationRevision: 1,
          }),
          writeSettings: async () => ({ isValid: false, reason: "非法" }),
        }) as never,
      createSettingsWriteRejectedError: (message: string) => new Error(message),
    });
    await expect(
      new PermissionFacet(failingHost.host).updateParameterAuthorizationSettings({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        toolAuthorizationShapes: [],
        isConfirmedByAuthenticatedUser: false,
      }),
    ).rejects.toThrow("参数授权设置写入被拒绝");
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
