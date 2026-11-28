/**
 * AXIOMATIC-DESIGN P2（2026-11-26）：运维只读子门面的独立契约。
 *
 * 只依赖窄宿主（启动恢复策略/报告、实验设置、成果记录、任务链查询）⇒ 可脱离 8540 行门面单测。
 */
import { describe, expect, it, vi } from "vitest";

import { OpsFacet } from "../../../packages/core/src/public-sdk-facets/ops-facet.js";

function buildHost(overrides: Record<string, unknown> = {}) {
  const assertOpen = vi.fn();
  const readStartupRecoveryPolicy = vi.fn(async () => ({
    policy: { isEnabled: true, maximumAutomaticResumeAttempts: 2 },
    isPersisted: true,
  }));
  const readStartupRecoveryReport = vi.fn(async () => null);
  const readExperimentSettings = vi.fn(async () => ({
    enabledExperimentIdentifiers: ["exp-a"],
    revision: 3,
  }));
  const readArtifactRecords = vi.fn(async () => ({
    records: [
      {
        artifactIdentifier: "art-1",
        projectIdentifier: "project-a",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-1",
        artifactType: "document",
        displayName: "说明",
        location: "docs/a.md",
        status: "unverified",
      },
      {
        artifactIdentifier: "art-2",
        projectIdentifier: "project-b",
        missionIdentifier: "mission-2",
        taskIdentifier: "T-2",
        artifactType: "document",
        displayName: "说明 2",
        location: "docs/b.md",
        status: "verified",
      },
    ],
  }));
  const queryMissionStatus = vi.fn(async (missionId: string) => ({
    taskChain: {
      tasks: [
        { id: "T-1", description: "有产物", status: "done", resultLocation: "out/a.md" },
        { id: "T-2", description: "无产物", status: "done", resultLocation: null },
        { id: "T-3", description: "空白产物", status: "running", resultLocation: "   " },
      ],
    },
    missionId,
  }));
  const host = {
    assertOpen,
    readStartupRecoveryPolicy,
    readStartupRecoveryReport,
    readExperimentSettings,
    readArtifactRecords,
    queryMissionStatus,
    ...overrides,
  };
  return { host: host as never, assertOpen, readArtifactRecords, queryMissionStatus };
}

describe("AXIOMATIC P2：运维只读子门面", () => {
  it("① 启动恢复状态：策略与报告原样返回且先 assertOpen", async () => {
    const { host, assertOpen } = buildHost();
    const facet = new OpsFacet(host);
    const state = await facet.queryStartupRecoveryState();
    expect(state).toMatchObject({ isPersisted: true, report: null });
    expect(state.policy).toMatchObject({ isEnabled: true });
    expect(assertOpen).toHaveBeenCalledTimes(1);
  });

  it("② 实验目录：enabled 依设置、canEnable 依 runtimeConsumerWired", async () => {
    const { host } = buildHost();
    const facet = new OpsFacet(host);
    const catalog = await facet.queryExperimentCatalog();
    expect(catalog.settings).toMatchObject({ revision: 3 });
    const enabled = catalog.entries.find((entry) => entry.experimentIdentifier === "exp-a");
    const disabled = catalog.entries.find((entry) => entry.experimentIdentifier !== "exp-a");
    if (enabled !== undefined) expect(enabled.isEnabled).toBe(true);
    if (disabled !== undefined) expect(disabled.isEnabled).toBe(false);
    expect(catalog.entries.every((entry) => typeof entry.canEnable === "boolean")).toBe(true);
  });

  it("③ 成果记录：无过滤/按项目/按 mission 三种过滤", async () => {
    const { host, readArtifactRecords } = buildHost();
    const facet = new OpsFacet(host);
    expect(await facet.queryArtifacts()).toHaveLength(2);
    expect(await facet.queryArtifacts({ projectIdentifier: "project-a" })).toHaveLength(1);
    expect(await facet.queryArtifacts({ missionIdentifier: "mission-2" })).toHaveLength(1);
    expect(await facet.queryArtifacts({ projectIdentifier: "project-missing" })).toHaveLength(0);
    expect(readArtifactRecords).toHaveBeenCalledTimes(4);
  });

  it("④ 任务成果投影：无任务链返回空；仅投影有 resultLocation 的任务", async () => {
    const { host } = buildHost();
    const facet = new OpsFacet(host);
    const projected = await facet.queryMissionArtifacts("mission-1");
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      artifactIdentifier: "task-result:T-1",
      taskIdentifier: "T-1",
      location: "out/a.md",
      source: "task-result-location",
    });

    const { host: noChainHost } = buildHost({
      queryMissionStatus: async () => ({ taskChain: null }),
    });
    expect(await new OpsFacet(noChainHost).queryMissionArtifacts("mission-missing")).toEqual([]);
  });

  it("⑤ assertOpen 抛错 ⇒ 不触达任何宿主读取", async () => {
    const { host, readArtifactRecords } = buildHost({
      assertOpen: () => {
        throw new Error("application-closed");
      },
    });
    await expect(new OpsFacet(host).queryArtifacts()).rejects.toThrow("application-closed");
    expect(readArtifactRecords).not.toHaveBeenCalled();
  });

  it("⑥ 工具失败 token 轨迹：历史缺失 ⇒ status=absent、空结果并给出原因", async () => {
    const { host } = buildHost({
      readRunHistory: async () => ({ kind: "absent", reason: "该 mission 没有运行历史文件。" }),
      readUsageLedgerEntries: async () => [],
    });
    const report = await new OpsFacet(host).queryToolFailureTokenTraces({
      missionIdentifier: "mission-1",
    });
    expect(report).toMatchObject({ traces: [], status: "absent", openWindowCount: 0 });
    expect(report.reason).toContain("没有运行历史");
  });

  it("⑦ 工具失败 token 轨迹：历史损坏 ⇒ status=invalid，不伪造 trace", async () => {
    const { host } = buildHost({
      readRunHistory: async () => ({ kind: "invalid", reason: "坏 JSON" }),
      readUsageLedgerEntries: async () => [],
    });
    const report = await new OpsFacet(host).queryToolFailureTokenTraces({
      missionIdentifier: "mission-1",
    });
    expect(report).toMatchObject({ traces: [], status: "invalid", reason: "坏 JSON" });
  });

  it("⑧ 工具失败 token 轨迹：正常关联失败窗口与用量", async () => {
    const { host } = buildHost({
      readRunHistory: async () => ({
        kind: "valid",
        document: {
          missionIdentifier: "mission-1",
          segments: [
            {
              events: [
                {
                  kind: "tool-failure",
                  recordedAtIso: "2026-11-28T10:00:00.000Z",
                  payloadJson: JSON.stringify({ toolName: "readFile", failureReason: "ENOENT" }),
                },
                {
                  kind: "tool-call",
                  recordedAtIso: "2026-11-28T10:02:00.000Z",
                  payloadJson: JSON.stringify({ toolName: "readFile", outputText: "ok" }),
                },
              ],
            },
          ],
        },
      }),
      readUsageLedgerEntries: async () => [
        {
          requestIdentifier: "req-1",
          missionIdentifier: "mission-1",
          inputTokenCount: 40,
          outputTokenCount: 10,
          recordedAtIso: "2026-11-28T10:01:00.000Z",
        },
      ],
    });
    const report = await new OpsFacet(host).queryToolFailureTokenTraces({
      missionIdentifier: "mission-1",
    });
    expect(report.status).toBe("ok");
    expect(report.traces).toHaveLength(1);
    expect(report.traces[0]).toMatchObject({
      toolName: "readFile",
      totalTokenCount: 50,
      isComplete: true,
      providerRequestCount: 1,
    });
  });
});
