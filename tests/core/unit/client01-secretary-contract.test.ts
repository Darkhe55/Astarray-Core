/**
 * SECRETARY-01-01 的反例（2026-10-18 R6）：实验性同级秘书的契约层。
 *
 * 卡内验收：**默认不创建实例**；不能读项目源文件、不能替用户授权、不能管理项目执行；
 * 工作区只在客户端数据目录的专职子目录；项目可见列表默认空；
 * 任务转交目标不明必须询问、**不得广播**。
 */
import { describe, expect, it } from "vitest";

import {
  SECRETARY_ALLOWED_CAPABILITIES,
  SECRETARY_DENIED_CAPABILITIES,
  buildSecretaryVisibleProjects,
  evaluateSecretaryActivation,
  evaluateSecretaryCapabilityRequest,
  planSecretaryTaskRelay,
} from "../../../packages/core/src/orchestration/secretary-agent-contract.js";

const workspaceInput = {
  isExperimentEnabled: true,
  isAuthenticatedUser: true,
  workspacePath: "D:/ClientData/secretary",
  clientDataDirectoryPath: "D:/ClientData",
  userHomeDirectoryPath: "C:/Users/someone",
  installationDirectoryPath: "C:/Program Files/Astarray",
};

describe("SECRETARY-01-01：实验开关、同级身份/目录边界、可见列表与只读报告契约", () => {
  it("① 默认关闭：开关未设置/false ⇒ 不可启用（默认不创建实例）", () => {
    expect(
      evaluateSecretaryActivation({ ...workspaceInput, isExperimentEnabled: undefined }),
    ).toMatchObject({ reasonCode: "disabled", isActivatable: false });
    expect(
      evaluateSecretaryActivation({ ...workspaceInput, isExperimentEnabled: false }),
    ).toMatchObject({ reasonCode: "disabled", isActivatable: false });
  });

  it("② 非认证用户 ⇒ 不可启用", () => {
    expect(
      evaluateSecretaryActivation({ ...workspaceInput, isAuthenticatedUser: false }),
    ).toMatchObject({ reasonCode: "not-authenticated", isActivatable: false });
  });

  it("③ 工作区必须绝对、且在客户端数据目录的专职子目录内", () => {
    expect(
      evaluateSecretaryActivation({ ...workspaceInput, workspacePath: "secretary" }),
    ).toMatchObject({ reasonCode: "workspace-not-absolute" });

    expect(
      evaluateSecretaryActivation({ ...workspaceInput, workspacePath: "C:/Users/someone/secretary" }),
    ).toMatchObject({ reasonCode: "workspace-outside-client-data" });

    // 整个客户端数据目录不算"专职子目录"
    expect(
      evaluateSecretaryActivation({ ...workspaceInput, workspacePath: "D:/ClientData" }),
    ).toMatchObject({ reasonCode: "workspace-outside-client-data" });
  });

  it("④ 工作区不得等于或包含用户主目录/安装目录（防整盘）", () => {
    expect(
      evaluateSecretaryActivation({
        ...workspaceInput,
        workspacePath: "C:/Users",
        clientDataDirectoryPath: "C:",
        userHomeDirectoryPath: "C:/Users/someone",
      }),
    ).toMatchObject({ reasonCode: "workspace-too-broad" });

    expect(
      evaluateSecretaryActivation({
        ...workspaceInput,
        workspacePath: "C:/Program Files",
        clientDataDirectoryPath: "C:",
        userHomeDirectoryPath: "C:/Users/someone",
      }),
    ).toMatchObject({ reasonCode: "workspace-too-broad" });

    expect(
      evaluateSecretaryActivation({ ...workspaceInput, workspacePath: "D:/ClientData/secretary/deep" }),
    ).toMatchObject({ reasonCode: "activatable", isActivatable: true });
  });

  it("⑤ 能力矩阵：只允许两项只读能力；被点名禁止的四项一律拒绝", () => {
    expect(SECRETARY_ALLOWED_CAPABILITIES).toEqual(["read-only-report-query", "status-query"]);
    for (const deniedCapability of SECRETARY_DENIED_CAPABILITIES) {
      const decision = evaluateSecretaryCapabilityRequest({
        capability: deniedCapability,
        visibleProjectIdentifiers: ["project-a"],
      });
      expect(decision.isAllowed).toBe(false);
    }
    expect(
      evaluateSecretaryCapabilityRequest({
        capability: "read-only-report-query",
        projectIdentifier: "project-a",
        visibleProjectIdentifiers: ["project-a"],
      }),
    ).toEqual({ isAllowed: true, capability: "read-only-report-query" });
    expect(
      evaluateSecretaryCapabilityRequest({
        capability: "write-project-file",
        visibleProjectIdentifiers: ["project-a"],
      }),
    ).toMatchObject({ isAllowed: false, reasonCode: "capability-denied" });
  });

  it("⑥ 不可见项目 ⇒ 只读报告也拒绝（不得读到未选择项目）", () => {
    const decision = evaluateSecretaryCapabilityRequest({
      capability: "read-only-report-query",
      projectIdentifier: "project-b",
      visibleProjectIdentifiers: ["project-a"],
    });
    expect(decision.isAllowed).toBe(false);
    if (decision.isAllowed) throw new Error("应为拒绝");
    expect(decision.reasonCode).toBe("project-not-visible");
  });

  it("⑦ 可见项目列表默认空；未知项目被剔除但如实报告（不静默丢失）", () => {
    expect(
      buildSecretaryVisibleProjects({ requestedProjectIdentifiers: [], knownProjectIdentifiers: ["project-a"] }),
    ).toMatchObject({ visibleProjectIdentifiers: [], isDefaultEmpty: true });

    const mixed = buildSecretaryVisibleProjects({
      requestedProjectIdentifiers: ["project-b", "project-a", "project-a", "ghost"],
      knownProjectIdentifiers: ["project-a", "project-b"],
    });
    expect(mixed.visibleProjectIdentifiers).toEqual(["project-b", "project-a"]);
    expect(mixed.unknownProjectIdentifiers).toEqual(["ghost"]);
    expect(mixed.isDefaultEmpty).toBe(false);
  });

  it("⑧ 任务转交：目标不明必须澄清、绝不广播；目标未知拒绝；目标明确则保留用户来源", () => {
    const missingTarget = planSecretaryTaskRelay({
      targetProjectIdentifier: null,
      knownProjectIdentifiers: ["project-a", "project-b"],
    });
    expect(missingTarget.kind).toBe("needs-clarification");
    expect(missingTarget.isBroadcast).toBe(false);

    const blankTarget = planSecretaryTaskRelay({
      targetProjectIdentifier: "   ",
      knownProjectIdentifiers: ["project-a"],
    });
    expect(blankTarget.kind).toBe("needs-clarification");

    const unknownTarget = planSecretaryTaskRelay({
      targetProjectIdentifier: "project-z",
      knownProjectIdentifiers: ["project-a"],
    });
    expect(unknownTarget.kind).toBe("rejected");

    const created = planSecretaryTaskRelay({
      targetProjectIdentifier: "project-a",
      knownProjectIdentifiers: ["project-a"],
    });
    expect(created.kind).toBe("proposal-created");
    if (created.kind !== "proposal-created") throw new Error("应为提案");
    expect(created.keepsOriginalUserSource).toBe(true);
    expect(created.isBroadcast).toBe(false);
  });

  it("⑨ 同级关系不产生上级能力：秘书没有任何授权/执行能力项", () => {
    const decisionKinds = SECRETARY_DENIED_CAPABILITIES.map(
      (capability) =>
        evaluateSecretaryCapabilityRequest({ capability, visibleProjectIdentifiers: [] }).isAllowed,
    );
    expect(decisionKinds.every((isAllowed) => isAllowed === false)).toBe(true);
    // 允许集合与禁止集合不相交
    expect(SECRETARY_ALLOWED_CAPABILITIES.some((capability) => SECRETARY_DENIED_CAPABILITIES.includes(capability))).toBe(false);
  });
});
