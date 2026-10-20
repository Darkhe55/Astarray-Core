/**
 * CONFIGCHAT-01-02 控制面反例（2026-10-20）。
 *
 * 卡内点名四类：**重复提交**、**并发编辑**、**撤权与在途任务**、**主 Agent 无写工具**。
 * 另加：秘密类设置、失败保留旧版本、安全点状态不谎称已生效。
 */
import { describe, expect, it } from "vitest";

import {
  applySettingChangeProposal,
  isSecretSettingKey,
  type SettingChangeLedgerEntry,
} from "../../../packages/core/src/orchestration/config-chat-control-plane.js";
import type { SettingChangeProposal } from "../../../packages/core/src/orchestration/config-chat-contract.js";

function proposal(overrides: Partial<SettingChangeProposal> = {}): SettingChangeProposal {
  return {
    settingKey: "permission-profile-default",
    proposedValueJson: JSON.stringify("standard"),
    scopeKind: "session",
    sourceKind: "authenticated-user",
    isExplicitUserInstruction: true,
    changeIdentifier: "change-1",
    expectedRevision: 1,
    currentRevision: 1,
    riskKinds: ["low"],
    ...overrides,
  };
}

const applyAlways: Parameters<typeof applySettingChangeProposal>[0]["applySetting"] = async (input) => ({
  appliedValueJson: input.proposedValueJson,
  appliedRevision: 2,
});

describe("CONFIGCHAT-01-02 配置控制面", () => {
  it("① 正常提交 ⇒ applied，并回传生效 revision", async () => {
    const { outcome, ledger } = await applySettingChangeProposal({
      proposal: proposal(),
      ledger: [],
      applySetting: applyAlways,
    });
    expect(outcome).toMatchObject({ kind: "applied", appliedRevision: 2, isImmediateInterception: false });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.outcome).toBe("applied");
  });

  it("② 重复提交（同 ID 同内容）⇒ idempotent-replay，不重复落地", async () => {
    let applyCallCount = 0;
    const first = await applySettingChangeProposal({
      proposal: proposal(),
      ledger: [],
      applySetting: async (input) => {
        applyCallCount += 1;
        return { appliedValueJson: input.proposedValueJson, appliedRevision: 2 };
      },
    });
    const second = await applySettingChangeProposal({
      proposal: proposal(),
      ledger: first.ledger,
      applySetting: async (input) => {
        applyCallCount += 1;
        return { appliedValueJson: input.proposedValueJson, appliedRevision: 3 };
      },
    });
    expect(second.outcome).toMatchObject({ kind: "idempotent-replay", previousOutcome: "applied" });
    expect(applyCallCount).toBe(1);
    expect(second.ledger).toHaveLength(1);
  });

  it("③ 同 ID 异内容 ⇒ conflict（不覆盖已记录变更）", async () => {
    const first = await applySettingChangeProposal({
      proposal: proposal(),
      ledger: [],
      applySetting: applyAlways,
    });
    const conflicting = await applySettingChangeProposal({
      proposal: proposal({ proposedValueJson: JSON.stringify("strict") }),
      ledger: first.ledger,
      applySetting: applyAlways,
    });
    expect(conflicting.outcome).toMatchObject({ kind: "rejected", reasonCode: "conflict" });
  });

  it("④ 并发编辑（expectedRevision 落后）⇒ stale-revision，不覆盖别人改动", async () => {
    const { outcome } = await applySettingChangeProposal({
      proposal: proposal({ expectedRevision: 1, currentRevision: 2 }),
      ledger: [],
      applySetting: applyAlways,
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "stale-revision" });
  });

  it("⑤ 主 Agent / 工具输出来源 ⇒ 拒绝（无写工具）", async () => {
    for (const sourceKind of ["model", "tool-output", "document", "lesson"] as const) {
      const { outcome } = await applySettingChangeProposal({
        proposal: proposal({ sourceKind }),
        ledger: [],
        applySetting: applyAlways,
      });
      expect(outcome.kind).toBe("rejected");
    }
  });

  it("⑥ 秘密类设置不进对话（即使来自用户）", async () => {
    const secretKey = "api-key";
    expect(isSecretSettingKey(secretKey)).toBe(true);
    const { outcome } = await applySettingChangeProposal({
      proposal: proposal({ settingKey: secretKey }),
      ledger: [],
      applySetting: applyAlways,
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reasonCode: "secret-setting-requires-protected-entry",
    });
  });

  it("⑦ 扩大权限 ⇒ 高风险必须显式确认；确认后立即拦截新操作", async () => {
    const unconfirmed = await applySettingChangeProposal({
      proposal: proposal({ riskKinds: ["expands-permissions"] }),
      ledger: [],
      applySetting: applyAlways,
    });
    expect(unconfirmed.outcome).toMatchObject({
      kind: "rejected",
      reasonCode: "explicit-confirmation-required",
    });

    const confirmed = await applySettingChangeProposal({
      proposal: proposal({ riskKinds: ["expands-permissions"] }),
      ledger: [],
      applySetting: applyAlways,
      isExplicitlyConfirmed: true,
    });
    expect(confirmed.outcome).toMatchObject({ kind: "applied", isImmediateInterception: true });
  });

  it("⑧ 影响在途任务 ⇒ awaiting-safe-point，且明确 isEffective=false", async () => {
    const { outcome, ledger } = await applySettingChangeProposal({
      proposal: proposal({ riskKinds: ["affects-other-tasks"] }),
      ledger: [],
      applySetting: applyAlways,
      isExplicitlyConfirmed: true,
      hasInFlightMissions: true,
    });
    expect(outcome).toMatchObject({ kind: "awaiting-safe-point", isEffective: false });
    expect(ledger[0]?.outcome).toBe("awaiting-safe-point");
  });

  it("⑨ 落地失败 ⇒ failed 且 previousValueKept=true（保留旧有效版本）", async () => {
    const { outcome, ledger } = await applySettingChangeProposal({
      proposal: proposal(),
      ledger: [],
      applySetting: async () => {
        throw new Error("设置存储不可写");
      },
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      previousValueKept: true,
    });
    expect(ledger[0]?.outcome).toBe("failed");
  });

  it("⑩ 作用范围含糊 ⇒ 拒绝并询问（不擅自永久化）", async () => {
    const { outcome } = await applySettingChangeProposal({
      proposal: proposal({ scopeKind: null }),
      ledger: [],
      applySetting: applyAlways,
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "scope-ambiguous" });
  });

  it("⑪ 不在公开白名单的设置键 ⇒ 拒绝（模型不能直接编辑配置文件）", async () => {
    const { outcome } = await applySettingChangeProposal({
      proposal: proposal({ settingKey: "internal.scheduler.threads" }),
      ledger: [],
      applySetting: applyAlways,
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "not-in-public-allowlist" });
  });

  it("⑫ 账目在多轮之间保持（幂等判据不依赖内存状态）", async () => {
    const ledger: ReadonlyArray<SettingChangeLedgerEntry> = await applySettingChangeProposal({
      proposal: proposal(),
      ledger: [],
      applySetting: applyAlways,
    }).then((result) => result.ledger);
    // 模拟进程重启：新调用只拿到持久化的账目
    const replay = await applySettingChangeProposal({
      proposal: proposal(),
      ledger,
      applySetting: applyAlways,
    });
    expect(replay.outcome.kind).toBe("idempotent-replay");
  });
});


