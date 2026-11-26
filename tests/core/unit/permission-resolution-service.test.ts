/**
 * AXIOMATIC-DESIGN P3（2026-11-26）：权限解析服务（端口注入）的反例。
 *
 * 服务把"读 profile → 概览 → 预览 → 基线"合成一处；控制器只注入端口。
 */
import { describe, expect, it, vi } from "vitest";

import { PermissionResolutionService } from "../../../packages/core/src/orchestration/permission-resolution-service.js";

const catalog = {
  listToolMappings: () => [
    { toolName: "readFile", capabilityIds: ["cap-read"] },
    { toolName: "processExecution", capabilityIds: [] },
  ],
  listToolActionMappings: () => [
    { toolName: "processExecution", actions: { start: ["cap-exec"] } },
  ],
};

const registry = {
  listRegisteredNames: () => ["readFile", "processExecution"],
  isRegistered: (toolName: string) => toolName === "readFile" || toolName === "processExecution",
};

function buildService(overrides: Partial<ConstructorParameters<typeof PermissionResolutionService>[0]> = {}) {
  const readProfile = vi.fn(async () => ({
    capabilityDecisions: { "cap-read": "allow" as const, "cap-exec": "deny" as const },
    toolDecisions: {},
    fallbackDecision: "allow" as const,
  }));
  const service = new PermissionResolutionService({
    readProfile,
    capabilityCatalog: catalog,
    registry,
    ...overrides,
  });
  return { service, readProfile };
}

describe("AXIOMATIC P3：权限解析服务", () => {
  it("① 概览：注入端口后返回排序结果", async () => {
    const { service } = buildService();
    const overview = await service.listToolOverview();
    expect(overview.map((entry) => entry.toolName)).toEqual(["processExecution", "readFile"]);
    expect(overview.find((entry) => entry.toolName === "processExecution")?.isActionOnly).toBe(true);
  });

  it("② 预览：动作命中 ⇒ 用动作能力集合重新计算基线", async () => {
    const { service } = buildService();
    const preview = await service.previewToolPermission({
      toolName: "processExecution",
      action: "start",
    });
    expect(preview.status).toBe("ok");
    expect(preview.capabilityIds).toEqual(["cap-exec"]);
    expect(preview.baselineDecision).toBe("deny");
  });

  it("③ 预览：未命中动作 ⇒ 回退到工具级基线与能力集合", async () => {
    const { service } = buildService();
    const preview = await service.previewToolPermission({ toolName: "readFile", action: "read" });
    expect(preview).toMatchObject({
      status: "ok",
      baselineDecision: "allow",
      capabilityIds: ["cap-read"],
    });
  });

  it("④ 预览：未知工具 ⇒ unknown-tool，且不猜基线", async () => {
    const { service } = buildService();
    expect(
      await service.previewToolPermission({ toolName: "nope", action: "read" }),
    ).toEqual({ status: "unknown-tool", baselineDecision: null, capabilityIds: [] });
  });

  it("⑤ 基线：无 profile ⇒ null（不回落 allow/false 假安全）", async () => {
    const { service } = buildService({ readProfile: async () => null });
    expect(await service.computeBaseline(["cap-read"], "readFile")).toBeNull();
    const overview = await service.listToolOverview();
    expect(overview.every((entry) => entry.baselineDecision === null)).toBe(true);
    expect(overview.every((entry) => entry.baselineSource === "unknown")).toBe(true);
  });

  it("⑥ 缺能力目录 ⇒ 空概览（服务不凭 registry 伪造工具）", async () => {
    const { service } = buildService({ capabilityCatalog: null });
    expect(await service.listToolOverview()).toEqual([]);
  });
});
