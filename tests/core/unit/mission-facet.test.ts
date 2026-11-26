/**
 * AXIOMATIC-DESIGN P2（2026-11-26）：mission 只读查询子门面的独立契约。
 *
 * 关键语义：`queryMissionStatus` 原实现**不校验关闭态**（保持兼容）；其余三个方法都先 `assertOpen()`。
 */
import { describe, expect, it, vi } from "vitest";

import { MissionFacet } from "../../../packages/core/src/public-sdk-facets/mission-facet.js";

function buildHost(overrides: Record<string, unknown> = {}) {
  const assertOpen = vi.fn();
  const queryMissionStatus = vi.fn(async () => ({
    missionId: "mission-1",
    summary: { status: "running" },
    taskChain: { tasks: [{ id: "T-1", status: "done" }] },
  }));
  const queryMissionTaskSequence = vi.fn(async () => ({
    missionIdentifier: "mission-1",
    sequenceIdentifier: "seq-1",
    taskIdentifier: "T-1",
    ownerAgentInstanceIdentifier: "agent-1",
    revision: 2,
    readyTaskIdentifiers: [],
    nodes: [],
  }));
  const requireSession = vi.fn();
  const requireTask = vi.fn(() => ({
    status: "running" as const,
    missionIdentifier: "mission-1",
    summaryPreview: null as string | null,
  }));
  const isTerminalStatus = vi.fn(
    (status: string) => status === "done" || status === "failed" || status === "cancelled",
  );
  const captureAuthoritativeResult = vi.fn(async () => undefined);
  const toTaskResult = vi.fn(
    (taskIdentifier: string, record: { status: string; missionIdentifier: string | null; summaryPreview: string | null }) => ({
      taskIdentifier,
      status: record.status,
      missionIdentifier: record.missionIdentifier,
      summaryPreview: record.summaryPreview,
    }),
  );
  const mapMissionStatus = vi.fn((status: { summary?: { status?: string } | null }) => {
    if (status.summary?.status === "done") return "done" as const;
    if (status.summary?.status === "cancelled") return "cancelled" as const;
    return "running" as const;
  });
  const host = {
    assertOpen,
    queryMissionStatus,
    queryMissionTaskSequence,
    mapMissionStatus,
    requireSession,
    requireTask,
    isTerminalStatus,
    captureAuthoritativeResult,
    toTaskResult,
    ...overrides,
  };
  return {
    host: host as never,
    assertOpen,
    queryMissionStatus,
    queryMissionTaskSequence,
    mapMissionStatus,
    requireTask,
    captureAuthoritativeResult,
  };
}

describe("AXIOMATIC P2：mission 只读查询子门面", () => {
  it("① queryMissionStatus 原样透传，且不触发 assertOpen（兼容旧语义）", async () => {
    const { host, assertOpen, queryMissionStatus } = buildHost();
    const facet = new MissionFacet(host);
    const status = (await facet.queryMissionStatus("mission-1")) as { missionId: string };
    expect(status.missionId).toBe("mission-1");
    expect(queryMissionStatus).toHaveBeenCalledWith("mission-1");
    expect(assertOpen).not.toHaveBeenCalled();
  });

  it("② 任务序列：先 assertOpen 再查询", async () => {
    const { host, assertOpen, queryMissionTaskSequence } = buildHost();
    const facet = new MissionFacet(host);
    const sequence = await facet.queryMissionTaskSequence("mission-1");
    expect(sequence?.sequenceIdentifier).toBe("seq-1");
    expect(assertOpen).toHaveBeenCalledTimes(1);
    expect(queryMissionTaskSequence).toHaveBeenCalledWith("mission-1");
  });

  it("③ 公开状态：经宿主映射函数得到 done/cancelled/running", async () => {
    const { host, mapMissionStatus } = buildHost();
    const facet = new MissionFacet(host);
    expect(await facet.queryMission("mission-1")).toEqual({
      missionIdentifier: "mission-1",
      status: "running",
    });

    const { host: doneHost } = buildHost({
      queryMissionStatus: async () => ({ missionId: "m", summary: { status: "done" }, taskChain: null }),
    });
    expect((await new MissionFacet(doneHost).queryMission("m")).status).toBe("done");
    expect(mapMissionStatus).toHaveBeenCalled();
  });

  it("④ 原始状态：无 summary ⇒ running；有 summary ⇒ 原值", async () => {
    const { host } = buildHost({
      queryMissionStatus: async () => ({ missionId: "m", summary: null, taskChain: null }),
    });
    expect(await new MissionFacet(host).queryMissionRawStatus("m")).toBe("running");

    const { host: cancelledHost } = buildHost({
      queryMissionStatus: async () => ({ missionId: "m", summary: { status: "cancelled" }, taskChain: null }),
    });
    expect(await new MissionFacet(cancelledHost).queryMissionRawStatus("m")).toBe("cancelled");
  });

  it("⑤ 关闭态：序列/公开状态/原始状态都拒绝，且不触达 controller", async () => {
    const { host, queryMissionStatus, queryMissionTaskSequence } = buildHost({
      assertOpen: () => {
        throw new Error("application-closed");
      },
    });
    const facet = new MissionFacet(host);
    await expect(facet.queryMissionTaskSequence("m")).rejects.toThrow("application-closed");
    await expect(facet.queryMission("m")).rejects.toThrow("application-closed");
    await expect(facet.queryMissionRawStatus("m")).rejects.toThrow("application-closed");
    expect(queryMissionStatus).not.toHaveBeenCalled();
    expect(queryMissionTaskSequence).not.toHaveBeenCalled();
  });

  it("⑥ queryTask：终态任务直接投影，不再查询 mission", async () => {
    const requireTask = vi.fn(() => ({
      status: "done" as const,
      missionIdentifier: "mission-1",
      summaryPreview: "结果",
    }));
    const { host, queryMissionStatus } = buildHost({ requireTask });
    const facet = new MissionFacet(host);
    const result = await facet.queryTask({ sessionId: "session-1", taskIdentifier: "T-1" });
    expect(result).toMatchObject({ taskIdentifier: "T-1", status: "done" });
    expect(requireTask).toHaveBeenCalledWith("T-1", "session-1");
    expect(queryMissionStatus).not.toHaveBeenCalled();
  });

  it("⑦ queryTask：无 mission 标识 ⇒ 直接投影（不猜 running）", async () => {
    const { host, queryMissionStatus } = buildHost({
      requireTask: vi.fn(() => ({
        status: "queued" as const,
        missionIdentifier: null,
        summaryPreview: null,
      })),
    });
    const result = await new MissionFacet(host).queryTask({
      sessionId: "session-1",
      taskIdentifier: "T-2",
    });
    expect(result).toMatchObject({ status: "queued", missionIdentifier: null });
    expect(queryMissionStatus).not.toHaveBeenCalled();
  });

  it("⑧ queryTask：非终态 ⇒ 以 mission 状态更新记录；转终态且无摘要 ⇒ 捕获权威结果", async () => {
    const record = {
      status: "running" as const,
      missionIdentifier: "mission-1",
      summaryPreview: null as string | null,
    };
    const { host, captureAuthoritativeResult } = buildHost({
      requireTask: vi.fn(() => record),
      queryMissionStatus: async () => ({ missionId: "mission-1", summary: { status: "done" }, taskChain: null }),
    });
    const result = await new MissionFacet(host).queryTask({
      sessionId: "session-1",
      taskIdentifier: "T-3",
    });
    expect(result.status).toBe("done");
    expect(captureAuthoritativeResult).toHaveBeenCalledTimes(1);
  });

  it("⑨ queryTask：关闭态 ⇒ 在触达记录前拒绝", async () => {
    const { host, requireTask } = buildHost({
      assertOpen: () => {
        throw new Error("application-closed");
      },
    });
    await expect(
      new MissionFacet(host).queryTask({ sessionId: "session-1", taskIdentifier: "T-4" }),
    ).rejects.toThrow("application-closed");
    expect(requireTask).not.toHaveBeenCalled();
  });
});
