/**
 * B9（2026-11-24）：`evaluateRemoteExportScope` 的分支反例。
 *
 * 覆盖：撤销/过期/非法时钟、项目越界、记录类别越界、目标账户（账户或用户身份）、
 * 设备不匹配/平台无设备标识、以及"越范围 ≠ 自动拒绝（需独立批准）"。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateRemoteExportScope,
  type RemoteIdentityBinding,
  type RemoteExportScopeRequest,
} from "../../../packages/core/src/orchestration/remote-evidence-export.js";

const binding: RemoteIdentityBinding = {
  bindingIdentifier: "binding-1",
  platformIdentifier: "platform-x",
  accountIdentifier: "account-1",
  deviceIdentifier: "device-1",
  authenticatedUserId: "user-1",
  authorizedProjectIdentifiers: ["project-a"],
  authorizedRecordKinds: ["run-summary", "task-status"],
  authorizationRevision: 1,
  expiresAtIso: "2099-01-01T00:00:00.000Z",
  createdAtIso: "2026-01-01T00:00:00.000Z",
  revokedAtIso: null,
};

const request: RemoteExportScopeRequest = {
  projectIdentifier: "project-a",
  recordKinds: ["run-summary"],
  targetAccountIdentifier: "user-1",
  targetDeviceIdentifier: "device-1",
};

const nowIso = "2026-11-24T00:00:00.000Z";

describe("B9：远端导出范围判定", () => {
  it("① 范围内 ⇒ within-preauthorization", () => {
    expect(evaluateRemoteExportScope({ binding, request, nowIso })).toEqual({
      kind: "within-preauthorization",
    });
  });

  it("② 已撤销 ⇒ denied（撤销优先于其它检查）", () => {
    expect(
      evaluateRemoteExportScope({
        binding: { ...binding, revokedAtIso: "2026-11-01T00:00:00.000Z" },
        request,
        nowIso,
      }),
    ).toEqual({ kind: "denied", reasons: ["绑定已撤销"] });
  });

  it("③ 过期或非法时钟 ⇒ denied", () => {
    expect(
      evaluateRemoteExportScope({
        binding: { ...binding, expiresAtIso: "2026-11-01T00:00:00.000Z" },
        request,
        nowIso,
      }),
    ).toEqual({ kind: "denied", reasons: ["绑定已过期"] });
    expect(
      evaluateRemoteExportScope({ binding, request, nowIso: "not-a-time" }),
    ).toEqual({ kind: "denied", reasons: ["绑定已过期"] });
  });

  it("④ 项目越界 ⇒ requires-independent-approval（不是自动拒绝）", () => {
    const decision = evaluateRemoteExportScope({
      binding,
      request: { ...request, projectIdentifier: "project-b" },
      nowIso,
    });
    expect(decision.kind).toBe("requires-independent-approval");
    if (decision.kind === "requires-independent-approval") {
      expect(decision.reasons.join("；")).toContain("project-b 不在授权范围");
    }
  });

  it("⑤ 记录类别越界 ⇒ requires-independent-approval", () => {
    const decision = evaluateRemoteExportScope({
      binding,
      request: { ...request, recordKinds: ["run-summary", "tool-activity"] },
      nowIso,
    });
    expect(decision.kind).toBe("requires-independent-approval");
    if (decision.kind === "requires-independent-approval") {
      expect(decision.reasons.join("；")).toContain("记录类别 tool-activity 不在授权范围");
    }
  });

  it("⑥ 目标账户 = 绑定账户 或 认证用户 ⇒ 允许（两种身份都合法）", () => {
    expect(
      evaluateRemoteExportScope({
        binding,
        request: { ...request, targetAccountIdentifier: "account-1" },
        nowIso,
      }),
    ).toEqual({ kind: "within-preauthorization" });
    expect(
      evaluateRemoteExportScope({
        binding,
        request: { ...request, targetAccountIdentifier: "user-1" },
        nowIso,
      }),
    ).toEqual({ kind: "within-preauthorization" });
  });

  it("⑦ 目标账户不一致 ⇒ requires-independent-approval", () => {
    const decision = evaluateRemoteExportScope({
      binding,
      request: { ...request, targetAccountIdentifier: "someone-else" },
      nowIso,
    });
    expect(decision.kind).toBe("requires-independent-approval");
    if (decision.kind === "requires-independent-approval") {
      expect(decision.reasons).toContain("目标账户与绑定账户不一致");
    }
  });

  it("⑧ 设备不一致 ⇒ requires-independent-approval；平台无设备标识 ⇒ 跳过设备检查", () => {
    const mismatched = evaluateRemoteExportScope({
      binding,
      request: { ...request, targetDeviceIdentifier: "device-2" },
      nowIso,
    });
    expect(mismatched.kind).toBe("requires-independent-approval");
    if (mismatched.kind === "requires-independent-approval") {
      expect(mismatched.reasons).toContain("目标设备与绑定设备不一致");
    }
    expect(
      evaluateRemoteExportScope({
        binding: { ...binding, deviceIdentifier: null },
        request: { ...request, targetDeviceIdentifier: null },
        nowIso,
      }),
    ).toEqual({ kind: "within-preauthorization" });
  });

  it("⑨ 多个越界同时存在 ⇒ 原因逐条返回（不合并成一句）", () => {
    const decision = evaluateRemoteExportScope({
      binding,
      request: {
        projectIdentifier: "project-b",
        recordKinds: ["tool-activity"],
        targetAccountIdentifier: "someone-else",
        targetDeviceIdentifier: "device-2",
      },
      nowIso,
    });
    expect(decision.kind).toBe("requires-independent-approval");
    if (decision.kind === "requires-independent-approval") {
      expect(decision.reasons.length).toBe(4);
    }
  });
});
