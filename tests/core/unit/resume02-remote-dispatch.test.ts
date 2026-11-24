/**
 * RESUME-02 远程投递接线测试（2026-11-24）：
 * 普通文本不读断点；未认证/通道不允许拒绝；无可恢复断点不编造；请求走产品路径并复用确定性幂等键。
 */
import { describe, expect, it, vi } from "vitest";

import { dispatchRemoteResume } from "../../../packages/core/src/orchestration/remote-resume-dispatch.js";
import type { ContinuationBreakpointView } from "../../../packages/core/src/orchestration/continuation-breakpoint.js";

const baseInput = {
  sourceChannel: "remote-im",
  authenticatedPrincipalIdentifier: "user-1",
  platformMessageIdentifier: "msg-1",
};

function makeBreakpoint(overrides: Partial<ContinuationBreakpointView> = {}): ContinuationBreakpointView {
  return {
    breakpointIdentifier: "bp-1",
    conversationIdentifier: "conv-1",
    missionIdentifier: "T-1",
    interruptionRevision: "rev-1",
    projectIdentifier: "project-1",
    taskShortName: "示例任务",
    interruptionReason: "mission-interrupted",
    status: "open",
    revision: 2,
    lastCheckpointIdentifier: "checkpoint-1",
    nextStep: "点击恢复",
    canResume: true,
    blockedReason: null,
    recordedAtIso: "2026-11-24T00:00:00.000Z",
    updatedAtIso: "2026-11-24T00:00:00.000Z",
    lastRequestIdentifier: null,
    ...overrides,
  };
}

describe("RESUME-02：远程投递接线", () => {
  it("① 普通文本 ⇒ ignored，且完全不读断点、不发请求", async () => {
    const findOpenBreakpoint = vi.fn();
    const requestContinuation = vi.fn();
    for (const text of ["继续", "接着做", "请把按钮改名为「继续」"]) {
      const result = await dispatchRemoteResume({
        ...baseInput,
        text,
        ports: { findOpenBreakpoint, requestContinuation },
      });
      expect(result.kind).toBe("ignored");
    }
    expect(findOpenBreakpoint).not.toHaveBeenCalled();
    expect(requestContinuation).not.toHaveBeenCalled();
  });

  it("② 未认证 / 通道不允许 ⇒ 拒绝，不读断点", async () => {
    const findOpenBreakpoint = vi.fn();
    const requestContinuation = vi.fn();
    const unauthenticated = await dispatchRemoteResume({
      ...baseInput,
      authenticatedPrincipalIdentifier: null,
      text: "/resume T-1",
      ports: { findOpenBreakpoint, requestContinuation },
    });
    expect(unauthenticated).toMatchObject({ kind: "rejected", reasonCode: "unauthenticated" });

    const wrongChannel = await dispatchRemoteResume({
      ...baseInput,
      sourceChannel: "untrusted-webhook",
      text: "/resume T-1",
      ports: { findOpenBreakpoint, requestContinuation },
    });
    expect(wrongChannel).toMatchObject({ kind: "rejected", reasonCode: "channel-not-allowed" });
    expect(findOpenBreakpoint).not.toHaveBeenCalled();
  });

  it("③ 解析失败（缺目标/多参数）⇒ rejected，不猜目标", async () => {
    const ports = { findOpenBreakpoint: vi.fn(), requestContinuation: vi.fn() };
    await expect(
      dispatchRemoteResume({ ...baseInput, text: "/resume", ports }),
    ).resolves.toMatchObject({ kind: "rejected", reasonCode: "missing-target" });
    await expect(
      dispatchRemoteResume({ ...baseInput, text: "/resume T-1 now", ports }),
    ).resolves.toMatchObject({ kind: "rejected", reasonCode: "too-many-arguments" });
    expect(ports.findOpenBreakpoint).not.toHaveBeenCalled();
  });

  it("④ 没有可续接断点 ⇒ no-breakpoint（不凭空造卡、不发请求）", async () => {
    const requestContinuation = vi.fn();
    const result = await dispatchRemoteResume({
      ...baseInput,
      text: "/resume T-1",
      ports: { findOpenBreakpoint: async () => null, requestContinuation },
    });
    expect(result).toMatchObject({ kind: "no-breakpoint", missionIdentifier: "T-1" });
    expect(requestContinuation).not.toHaveBeenCalled();
  });

  it("⑤ 断点不可恢复 ⇒ not-resumable，携带真实原因，不发请求", async () => {
    const requestContinuation = vi.fn();
    const result = await dispatchRemoteResume({
      ...baseInput,
      text: "/resume T-1",
      ports: {
        findOpenBreakpoint: async () =>
          makeBreakpoint({ canResume: false, blockedReason: "缺少可信检查点" }),
        requestContinuation,
      },
    });
    expect(result).toMatchObject({
      kind: "not-resumable",
      breakpointIdentifier: "bp-1",
      detail: "缺少可信检查点",
    });
    expect(requestContinuation).not.toHaveBeenCalled();
  });

  it("⑥ 可恢复断点 ⇒ 走产品路径请求，幂等键确定性、revision 来自卡片", async () => {
    const requests: unknown[] = [];
    const requestContinuation = vi.fn(async (input: unknown) => {
      requests.push(input);
      return {
        outcome: "resumed" as const,
        reason: "已派发恢复",
        breakpoint: makeBreakpoint(),
      };
    });
    const ports = { findOpenBreakpoint: async () => makeBreakpoint(), requestContinuation };

    const first = await dispatchRemoteResume({ ...baseInput, text: "/resume T-1", ports });
    const retry = await dispatchRemoteResume({ ...baseInput, text: "  /resume   T-1  ", ports });

    expect(first).toMatchObject({
      kind: "requested",
      missionIdentifier: "T-1",
      breakpointIdentifier: "bp-1",
      outcome: "resumed",
    });
    expect(retry).toMatchObject({ kind: "requested", outcome: "resumed" });
    const firstRequest = requests[0] as {
      requestIdentifier: string;
      expectedRevision: number;
      breakpointIdentifier: string;
    };
    const retryRequest = requests[1] as { requestIdentifier: string };
    expect(firstRequest.breakpointIdentifier).toBe("bp-1");
    expect(firstRequest.expectedRevision).toBe(2);
    expect(firstRequest.requestIdentifier).toBe(retryRequest.requestIdentifier);
  });

  it("⑦ controller 判 blocked 时如实透传（不伪装成功）", async () => {
    const result = await dispatchRemoteResume({
      ...baseInput,
      text: "/resume T-1",
      ports: {
        findOpenBreakpoint: async () => makeBreakpoint(),
        requestContinuation: async () => ({
          outcome: "blocked",
          reason: "恢复门禁拒绝：租约冲突",
          breakpoint: makeBreakpoint(),
        }),
      },
    });
    expect(result).toMatchObject({
      kind: "requested",
      outcome: "blocked",
      reason: "恢复门禁拒绝：租约冲突",
    });
  });
});
