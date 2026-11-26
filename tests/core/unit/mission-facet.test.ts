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
    ...overrides,
  };
  return { host: host as never, assertOpen, queryMissionStatus, queryMissionTaskSequence, mapMissionStatus };
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
});
