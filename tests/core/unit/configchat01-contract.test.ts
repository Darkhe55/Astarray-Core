/**
 * CONFIGCHAT-01-01 的反例（2026-10-18 R18）：设置白名单、来源、作用域、风险与幂等。
 *
 * 卡内验收：文档注入、模型伪造用户、模糊范围、旧 revision 拒绝；
 * 秘密信息不进对话；扩大权限/影响其他任务/可能断连必须显式确认；在途不可假装已应用。
 */
import { describe, expect, it } from "vitest";

import {
  CHAT_SETTING_ALLOWLIST,
  CHAT_SETTING_SECRET_KEYS,
  classifySettingChangeIdentity,
  computeSettingChangeContentFingerprint,
  evaluateSettingApplyStatus,
  evaluateSettingChangeProposal,
  type SettingChangeProposal,
} from "../../../packages/core/src/orchestration/config-chat-contract.js";

function proposal(overrides: Partial<SettingChangeProposal> = {}): SettingChangeProposal {
  return {
    settingKey: "mode-selection",
    proposedValueJson: '"assist"',
    scopeKind: "session",
    sourceKind: "authenticated-user",
    isExplicitUserInstruction: true,
    changeIdentifier: "change-1",
    expectedRevision: 3,
    currentRevision: 3,
    riskKinds: ["low"],
    ...overrides,
  };
}

describe("CONFIGCHAT-01-01：设置事务/来源/风险契约", () => {
  it("① 秘密类设置拒绝进对话；非白名单设置拒绝（模型不能直接编辑配置）", () => {
    for (const secretKey of CHAT_SETTING_SECRET_KEYS) {
      expect(evaluateSettingChangeProposal(proposal({ settingKey: secretKey }))).toMatchObject({
        kind: "reject",
        reasonCode: "secret-setting-requires-protected-entry",
      });
    }
    expect(evaluateSettingChangeProposal(proposal({ settingKey: "internal-flag" }))).toMatchObject({
      kind: "reject",
      reasonCode: "not-in-public-allowlist",
    });
    expect(CHAT_SETTING_ALLOWLIST).toContain("work-window-rules");
  });

  it("② 工具输出/文档/经验文字冒充用户 ⇒ 拒绝（模型伪造用户）", () => {
    for (const sourceKind of ["model", "tool-output", "document", "lesson"] as const) {
      expect(evaluateSettingChangeProposal(proposal({ sourceKind }))).toMatchObject({
        kind: "reject",
        reasonCode: "requires-authenticated-user-source",
      });
    }
  });

  it("③ 作用范围含糊 ⇒ 拒绝并要求询问（不擅自持久化）", () => {
    expect(evaluateSettingChangeProposal(proposal({ scopeKind: null }))).toMatchObject({
      kind: "reject",
      reasonCode: "scope-ambiguous",
    });
  });

  it("④ 旧 revision ⇒ 拒绝；缺变更 ID ⇒ 拒绝", () => {
    expect(evaluateSettingChangeProposal(proposal({ expectedRevision: 2 }))).toMatchObject({
      kind: "reject",
      reasonCode: "stale-revision",
    });
    expect(evaluateSettingChangeProposal(proposal({ changeIdentifier: " " }))).toMatchObject({
      kind: "reject",
      reasonCode: "missing-change-identifier",
    });
  });

  it("⑤ 风险类别：扩大权限/影响其他任务/可能断连 ⇒ 即使来自用户也必须显式确认", () => {
    for (const riskKind of ["expands-permissions", "affects-other-tasks", "may-disconnect"] as const) {
      const decision = evaluateSettingChangeProposal(proposal({ riskKinds: [riskKind] }));
      expect(decision.kind).toBe("submit");
      if (decision.kind !== "submit") throw new Error("应提交");
      expect(decision.requiresExplicitConfirmation).toBe(true);
    }
  });

  it("⑥ 低风险 + 用户明确精确指令 ⇒ 直接提交不重复确认；非明确 ⇒ 需确认一次", () => {
    const explicit = evaluateSettingChangeProposal(proposal());
    expect(explicit).toMatchObject({ kind: "submit", requiresExplicitConfirmation: false });

    const vague = evaluateSettingChangeProposal(proposal({ isExplicitUserInstruction: false }));
    expect(vague).toMatchObject({ kind: "submit", requiresExplicitConfirmation: true });
  });

  it("⑦ 幂等：同 ID 同内容复用；同 ID 异内容拒绝；新 ID 新变更", () => {
    const contentFingerprint = computeSettingChangeContentFingerprint({
      settingKey: "mode-selection",
      proposedValueJson: '"assist"',
      scopeKind: "session",
    });
    const existing = [{ changeIdentifier: "change-1", contentFingerprint }];
    expect(
      classifySettingChangeIdentity({ changeIdentifier: "change-1", contentFingerprint, existingChanges: existing }).kind,
    ).toBe("idempotent-replay");
    expect(
      classifySettingChangeIdentity({
        changeIdentifier: "change-1",
        contentFingerprint: "different",
        existingChanges: existing,
      }).kind,
    ).toBe("conflict");
    expect(
      classifySettingChangeIdentity({
        changeIdentifier: "change-2",
        contentFingerprint,
        existingChanges: existing,
      }).kind,
    ).toBe("new");

    const otherScope = computeSettingChangeContentFingerprint({
      settingKey: "mode-selection",
      proposedValueJson: '"assist"',
      scopeKind: "persistent-default",
    });
    expect(otherScope).not.toBe(contentFingerprint);
  });

  it("⑧ 状态语义：等待安全点不等于已生效；权限收紧立即拦截新操作；失败保留旧版本", () => {
    expect(
      evaluateSettingApplyStatus({ status: "awaiting-safe-point", tightensPermissions: false }),
    ).toMatchObject({ isAppliedRightNow: false, blocksNewOperations: false });
    expect(
      evaluateSettingApplyStatus({ status: "saved", tightensPermissions: false }).isAppliedRightNow,
    ).toBe(false);
    expect(
      evaluateSettingApplyStatus({ status: "effective", tightensPermissions: false }).isAppliedRightNow,
    ).toBe(true);
    expect(
      evaluateSettingApplyStatus({ status: "awaiting-safe-point", tightensPermissions: true }),
    ).toMatchObject({ blocksNewOperations: true });
    expect(
      evaluateSettingApplyStatus({ status: "failed", tightensPermissions: true }).message,
    ).toContain("旧有效版本");
  });
});
