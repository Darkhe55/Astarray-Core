/**
 * AXIOMATIC-DESIGN P4（2026-11-26）：目标门禁适配器的反例。
 *
 * 语义：判定必记录；只有强制开关为 true 才真的阻断；解析为 null 与未装配同义（不阻断）。
 */
import { describe, expect, it, vi } from "vitest";

import { GoalDispatchGateAdapter } from "../../../packages/core/src/orchestration/goal-dispatch-gate-adapter.js";

const contract = {
  goalIdentifier: "goal-1",
  revision: 3,
  scope: { projectIdentifiers: ["project-a"], allowedToolNames: null },
  deadlineIso: null,
  resourceLimits: { maximumToolCalls: null },
  nonViolableInvariants: [],
} as never;

function buildGate(overrides: Record<string, unknown> = {}) {
  return {
    getState: () => ({
      goalIdentifier: "goal-1",
      contractRevision: 3,
      completedGroupCount: 0,
      checksSinceLastReduction: 0,
      lastPotentialValue: null,
      isPaused: false,
      pauseReason: null,
      evidenceGaps: [],
      consumedToolCalls: 0,
      requiresReplanning: false,
    }),
    assertMissionDispatchAllowed: () => ({
      isAllowed: true,
      remainingBudget: { toolCalls: null },
      groupsUntilNextProgressCheck: 3,
    }),
    ...overrides,
  };
}

function buildAdapter(options: {
  gate?: unknown;
  enforcement?: boolean;
  projectIdentifier?: string;
} = {}) {
  const onVerdict = vi.fn();
  const streamOutput = vi.fn();
  const adapter = new GoalDispatchGateAdapter({
    resolveGate: () => (options.gate === undefined ? null : (options.gate as never)),
    readProjectIdentifier: () => options.projectIdentifier ?? "project-a",
    isEnforcementEnabled: () => options.enforcement === true,
    onVerdict,
    streamOutput,
    nowIso: () => "2026-11-26T12:00:00.000Z",
  });
  return { adapter, onVerdict, streamOutput };
}

describe("AXIOMATIC P4：目标门禁适配器", () => {
  it("① 未装配/解析为 null ⇒ 不阻断且不记录判定", () => {
    const { adapter, onVerdict } = buildAdapter();
    expect(adapter.observeMissionDispatch("mission-1")).toEqual({ isBlocked: false, detail: null });
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("② 允许派发 ⇒ 记录 isAllowed=true 且不输出警告", () => {
    const { adapter, onVerdict, streamOutput } = buildAdapter({ gate: buildGate() });
    expect(adapter.observeMissionDispatch("mission-1")).toEqual({ isBlocked: false, detail: null });
    expect(onVerdict).toHaveBeenCalledTimes(1);
    expect(onVerdict.mock.calls[0]?.[0]).toMatchObject({
      isAllowed: true,
      reasonCode: null,
      evidenceGaps: [],
      isEnforced: false,
    });
    expect(streamOutput).not.toHaveBeenCalled();
  });

  it("③ 拒绝 + 仅观察 ⇒ 不阻断，但记录原因并输出「仅观察」", () => {
    const gate = buildGate({
      assertMissionDispatchAllowed: () => ({
        isAllowed: false,
        reasonCode: "goal-paused",
        detail: "目标已暂停",
        evidenceGaps: ["缺证据"],
      }),
    });
    const { adapter, onVerdict, streamOutput } = buildAdapter({ gate, enforcement: false });
    expect(adapter.observeMissionDispatch("mission-1")).toEqual({
      isBlocked: false,
      detail: "目标已暂停",
    });
    expect(onVerdict.mock.calls[0]?.[0]).toMatchObject({
      isAllowed: false,
      reasonCode: "goal-paused",
      evidenceGaps: ["缺证据"],
      isEnforced: false,
    });
    expect(streamOutput.mock.calls[0]?.[1]).toContain("仅观察（未阻断）");
  });

  it("④ 拒绝 + 强制 ⇒ 阻断派发，且 isEnforced=true", () => {
    const gate = buildGate({
      assertMissionDispatchAllowed: () => ({
        isAllowed: false,
        reasonCode: "scope-violation",
        detail: "项目不在目标范围",
        evidenceGaps: [],
      }),
    });
    const { adapter, onVerdict, streamOutput } = buildAdapter({ gate, enforcement: true });
    expect(adapter.observeMissionDispatch("mission-1")).toEqual({
      isBlocked: true,
      detail: "项目不在目标范围",
    });
    expect(onVerdict.mock.calls[0]?.[0]).toMatchObject({ isEnforced: true });
    expect(streamOutput.mock.calls[0]?.[1]).toContain("阻断派发");
  });

  it("⑤ 观察时间与项目标识来自端口（不被适配器猜测）", () => {
    const { adapter, onVerdict } = buildAdapter({
      gate: buildGate(),
      projectIdentifier: "project-b",
    });
    adapter.observeMissionDispatch("mission-9");
    expect(onVerdict.mock.calls[0]?.[0]).toMatchObject({
      missionIdentifier: "mission-9",
      projectIdentifier: "project-b",
      contractRevision: 3,
      observedAtIso: "2026-11-26T12:00:00.000Z",
    });
    void contract;
  });
});
