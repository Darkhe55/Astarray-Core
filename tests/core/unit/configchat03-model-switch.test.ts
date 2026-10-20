/**
 * CONFIGCHAT-01-03 反例（2026-10-20）：通信依赖保护、准备/切换/失败恢复、重启对账。
 */
import { describe, expect, it } from "vitest";

import {
  computeCommunicationModelSwitchFingerprint,
  describeCommunicationModelSwitchUiState,
  planCommunicationModelSwitch,
  reconcileCommunicationModelSwitchAfterRestart,
  type CommunicationModelSwitchRequest,
} from "../../../packages/core/src/orchestration/communication-model-switch.js";

function request(overrides: Partial<CommunicationModelSwitchRequest> = {}): CommunicationModelSwitchRequest {
  return {
    requestIdentifier: "req-1",
    currentModelIdentifier: "model-a",
    targetModelIdentifier: "model-b",
    availableModelIdentifiers: ["model-a", "model-b"],
    hasInFlightMissions: false,
    isNetworkAvailable: true,
    isUserCancelled: false,
    ...overrides,
  };
}

describe("CONFIGCHAT-01-03 模型切换保护", () => {
  it("① 正常切换 ⇒ switch-immediately，并给出回滚目标", () => {
    const plan = planCommunicationModelSwitch(request());
    expect(plan).toMatchObject({
      kind: "switch-immediately",
      targetModelIdentifier: "model-b",
      rollbackModelIdentifier: "model-a",
    });
    expect(describeCommunicationModelSwitchUiState(plan)).toBe("preparing");
  });

  it("② 禁用最后一个可用模型 ⇒ 拒绝（会切断通信）", () => {
    const plan = planCommunicationModelSwitch(
      request({ availableModelIdentifiers: [], currentModelIdentifier: "model-a" }),
    );
    expect(plan).toMatchObject({
      kind: "reject",
      reasonCode: "would-break-communication",
      stillUsableModelIdentifiers: [],
    });
    expect(describeCommunicationModelSwitchUiState(plan)).toBe("rejected");
  });

  it("③ 目标不可用 ⇒ 拒绝，并列出当前仍可用的模型", () => {
    const plan = planCommunicationModelSwitch(
      request({ targetModelIdentifier: "model-z", availableModelIdentifiers: ["model-a"] }),
    );
    expect(plan).toMatchObject({ kind: "reject", reasonCode: "target-unavailable" });
    if (plan.kind === "reject") {
      expect(plan.stillUsableModelIdentifiers).toEqual(["model-a"]);
    }
  });

  it("④ 断网 ⇒ 拒绝（不假装切换成功），且不影响现有模型", () => {
    const plan = planCommunicationModelSwitch(request({ isNetworkAvailable: false }));
    expect(plan).toMatchObject({ kind: "reject", reasonCode: "network-unavailable" });
  });

  it("⑤ 用户主动停止 ⇒ cancelled 状态，不后台重试", () => {
    const plan = planCommunicationModelSwitch(request({ isUserCancelled: true }));
    expect(plan).toMatchObject({ kind: "reject", reasonCode: "user-cancelled" });
    expect(describeCommunicationModelSwitchUiState(plan)).toBe("cancelled");
  });

  it("⑥ 同模型 ⇒ 说明无需切换（不制造'已完成'错觉）", () => {
    const plan = planCommunicationModelSwitch(
      request({ currentModelIdentifier: "model-b", targetModelIdentifier: "model-b" }),
    );
    expect(plan).toMatchObject({ kind: "reject", reasonCode: "same-model" });
  });

  it("⑦ 在途任务 ⇒ 安全点切换，且 isEffective=false / UI 为 awaiting-safe-point", () => {
    const plan = planCommunicationModelSwitch(request({ hasInFlightMissions: true }));
    expect(plan).toMatchObject({ kind: "switch-at-safe-point", isEffective: false });
    expect(describeCommunicationModelSwitchUiState(plan)).toBe("awaiting-safe-point");
  });

  it("⑧ 判定顺序：断网 + 同模型时先报断网（不报'无需切换'）", () => {
    const plan = planCommunicationModelSwitch(
      request({
        currentModelIdentifier: "model-b",
        targetModelIdentifier: "model-b",
        isNetworkAvailable: false,
      }),
    );
    expect(plan).toMatchObject({ kind: "reject", reasonCode: "network-unavailable" });
  });

  it("⑨ 判定顺序：无可用模型 + 用户取消 ⇒ 先报会切断通信", () => {
    const plan = planCommunicationModelSwitch(
      request({ availableModelIdentifiers: [], isUserCancelled: true }),
    );
    expect(plan).toMatchObject({ kind: "reject", reasonCode: "would-break-communication" });
  });

  it("⑩ 重启对账：持久化目标 ≠ 运行时生效 ⇒ recovery-needed（不谎报已切换）", () => {
    const outcome = reconcileCommunicationModelSwitchAfterRestart({
      persistedTargetModelIdentifier: "model-b",
      runtimeEffectiveModelIdentifier: "model-a",
    });
    expect(outcome.kind).toBe("recovery-needed");
    expect(outcome.reason).toContain("不谎报");
  });

  it("⑪ 重启对账：一致 ⇒ consistent；无持久化目标 ⇒ consistent（无事可对账）", () => {
    expect(
      reconcileCommunicationModelSwitchAfterRestart({
        persistedTargetModelIdentifier: "model-b",
        runtimeEffectiveModelIdentifier: "model-b",
      }).kind,
    ).toBe("consistent");
    expect(
      reconcileCommunicationModelSwitchAfterRestart({
        persistedTargetModelIdentifier: null,
        runtimeEffectiveModelIdentifier: "model-a",
      }).kind,
    ).toBe("consistent");
  });

  it("⑫ 切换指纹只含请求标识/当前/目标（同请求幂等，不因网络抖动重复切换）", () => {
    const first = computeCommunicationModelSwitchFingerprint(request());
    const second = computeCommunicationModelSwitchFingerprint(
      request({ isNetworkAvailable: false, hasInFlightMissions: true }),
    );
    expect(first).toBe(second);
    const third = computeCommunicationModelSwitchFingerprint(
      request({ targetModelIdentifier: "model-c" }),
    );
    expect(third).not.toBe(first);
  });
});
