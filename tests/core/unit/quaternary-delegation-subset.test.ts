/**
 * REPAIR（权限求交族）：四级委派**子集校验**。
 *
 * 反例优先：
 * - 工具子集超出三级允许 ⇒ 拒绝；
 * - 期限晚于三级 ⇒ 拒绝；
 * - 边界不可得 ⇒ 拒绝（不得默认放宽）；
 * - 合法子集 ⇒ 创建成功。
 */
import { describe, expect, it } from "vitest";

import { QUATERNARY_DELEGATION_SCHEMA_VERSION } from "../../../packages/core/src/orchestration/agent-routing-schemas.js";
import { QuaternaryLifecycleController } from "../../../packages/core/src/orchestration/quaternary-lifecycle-controller.js";

function buildDelegation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: QUATERNARY_DELEGATION_SCHEMA_VERSION,
    delegationId: "deleg-1",
    delegatingTertiaryAgentInstanceId: "tertiary-1",
    quaternaryAgentInstanceId: "quaternary-1",
    boundSubchainTaskIds: ["T-002"],
    permissionSubset: "read-only",
    allowedToolNamesSubset: ["readFile"],
    resourceScopeSubset: "project",
    expiresAtIso: "2026-11-11T00:00:00.000Z",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    ...overrides,
  } as never;
}

const boundary = {
  allowedToolNames: ["readFile", "listDirectory"],
  expiresAtIso: "2026-11-12T00:00:00.000Z",
  allowedResourceScopes: ["project"],
  permissionDecision: { kind: "allow" } as never,
};

function buildController(resolve: (id: string) => typeof boundary | null) {
  return new QuaternaryLifecycleController({
    isTertiaryAgentActive: () => true,
    resolveTertiaryDelegationBoundary: resolve as never,
  });
}

describe("四级委派子集校验", () => {
  it("**工具子集超出三级** ⇒ 拒绝", () => {
    const controller = buildController(() => boundary);
    expect(() =>
      controller.createQuaternaryAgent({
        delegation: buildDelegation({ allowedToolNamesSubset: ["readFile", "deleteRepository"] }),
      }),
    ).toThrow(/超出三级允许范围/u);
  });

  it("**期限晚于三级** ⇒ 拒绝", () => {
    const controller = buildController(() => boundary);
    expect(() =>
      controller.createQuaternaryAgent({
        delegation: buildDelegation({ expiresAtIso: "2026-11-20T00:00:00.000Z" }),
      }),
    ).toThrow(/期限/u);
  });

  it("**边界不可得** ⇒ 拒绝（不得默认放宽）", () => {
    const controller = buildController(() => null);
    expect(() => controller.createQuaternaryAgent({ delegation: buildDelegation() })).toThrow(/边界不可得/u);
  });

  it("合法子集 ⇒ 创建成功", () => {
    const controller = buildController(() => boundary);
    const record = controller.createQuaternaryAgent({ delegation: buildDelegation() });
    expect(record.delegation.quaternaryAgentInstanceId).toBe("quaternary-1");
    expect(record.lifecycle.status).toBe("active");
  });
});
