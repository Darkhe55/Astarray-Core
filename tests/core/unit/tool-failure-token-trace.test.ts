/**
 * TOKTRACE-01（2026-11-28）：工具失败 → 下一次成功的 token 消耗关联（反例矩阵）。
 *
 * 口径：窗口只到**该工具**下一次成功；窗口内统计该 mission 的全部 Provider 请求；
 * 未知用量记为缺失、不补 0；未关窗不产出 trace；非法时间戳计数跳过。
 */
import { describe, expect, it } from "vitest";

import {
  buildToolFailureTokenTraces,
  extractToolActivityEvents,
} from "../../../packages/core/src/orchestration/tool-failure-token-trace.js";

const failure = (at: string, tool = "readFile", reason = "ENOENT") => ({
  missionIdentifier: "mission-1",
  toolName: tool,
  kind: "failure" as const,
  recordedAtIso: at,
  failureReason: reason,
});

const success = (at: string, tool = "readFile") => ({
  missionIdentifier: "mission-1",
  toolName: tool,
  kind: "success" as const,
  recordedAtIso: at,
});

const usage = (at: string, input: number | null, output: number | null, mission: string | null = "mission-1") => ({
  missionIdentifier: mission,
  inputTokenCount: input,
  outputTokenCount: output,
  observedAtIso: at,
  requestIdentifier: "req-" + at,
});

describe("TOKTRACE-01：工具失败 token 关联", () => {
  it("① 只统计窗口内请求（失败前、成功后的请求都不计入）", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [failure("2026-11-28T10:00:00.000Z"), success("2026-11-28T10:05:00.000Z")],
      usageObservations: [
        usage("2026-11-28T09:59:00.000Z", 100, 100),
        usage("2026-11-28T10:01:00.000Z", 30, 20),
        usage("2026-11-28T10:03:00.000Z", 5, 5),
        usage("2026-11-28T10:06:00.000Z", 999, 999),
      ],
    });
    expect(report.traces).toHaveLength(1);
    const trace = report.traces[0]!;
    expect(trace.providerRequestCount).toBe(2);
    expect(trace.inputTokenCount).toBe(35);
    expect(trace.outputTokenCount).toBe(25);
    expect(trace.totalTokenCount).toBe(60);
    expect(trace.isComplete).toBe(true);
    expect(trace.durationMilliseconds).toBe(5 * 60 * 1000);
    expect(trace.log.map((entry) => entry.kind)).toEqual([
      "tool-failure",
      "provider-request",
      "provider-request",
      "tool-success",
    ]);
  });

  it("② 其他工具成功不关窗", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [
        failure("2026-11-28T10:00:00.000Z", "readFile"),
        success("2026-11-28T10:01:00.000Z", "writeFile"),
        success("2026-11-28T10:03:00.000Z", "readFile"),
      ],
      usageObservations: [usage("2026-11-28T10:02:00.000Z", 10, 10)],
    });
    expect(report.traces).toHaveLength(1);
    expect(report.traces[0]!.providerRequestCount).toBe(1);
    expect(report.traces[0]!.totalTokenCount).toBe(20);
  });

  it("③ 连续两次失败后成功 ⇒ 一条 trace，failureCount=2，日志两条失败", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [
        failure("2026-11-28T10:00:00.000Z"),
        failure("2026-11-28T10:02:00.000Z", "readFile", "EACCES"),
        success("2026-11-28T10:04:00.000Z"),
      ],
      usageObservations: [usage("2026-11-28T10:03:00.000Z", 7, 3)],
    });
    expect(report.traces).toHaveLength(1);
    expect(report.traces[0]!.failureCount).toBe(2);
    expect(report.traces[0]!.failureReason).toBe("ENOENT");
    expect(report.traces[0]!.log.filter((entry) => entry.kind === "tool-failure")).toHaveLength(2);
    expect(report.traces[0]!.totalTokenCount).toBe(10);
  });

  it("④ 用量未知 ⇒ 缺计但总额不补 0，isComplete=false", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [failure("2026-11-28T10:00:00.000Z"), success("2026-11-28T10:03:00.000Z")],
      usageObservations: [
        usage("2026-11-28T10:01:00.000Z", null, null),
        usage("2026-11-28T10:02:00.000Z", 12, 8),
      ],
    });
    const trace = report.traces[0]!;
    expect(trace.missingUsageRequestCount).toBe(1);
    expect(trace.isComplete).toBe(false);
    expect(trace.totalTokenCount).toBe(20);
    const unknownEntry = trace.log.find(
      (entry) => entry.kind === "provider-request" && entry.inputTokenCount === null,
    );
    expect(unknownEntry?.detail).toContain("用量未知");
  });

  it("⑤ 未关窗（失败后无成功）⇒ 不产出 trace，openWindowCount=1", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [failure("2026-11-28T10:00:00.000Z")],
      usageObservations: [usage("2026-11-28T10:01:00.000Z", 1, 1)],
    });
    expect(report.traces).toEqual([]);
    expect(report.openWindowCount).toBe(1);
  });

  it("⑥ 非法时间戳计入 skippedEventCount，不影响正常窗口", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [
        {
          missionIdentifier: "mission-1",
          toolName: "readFile",
          kind: "failure",
          recordedAtIso: "not-a-time",
          failureReason: "x",
        },
        failure("2026-11-28T10:00:00.000Z"),
        success("2026-11-28T10:01:00.000Z"),
      ],
      usageObservations: [usage("bad-time", 1, 1)],
    });
    expect(report.skippedEventCount).toBe(2);
    expect(report.traces).toHaveLength(1);
  });

  it("⑦ 不同 mission 的同名工具互不串窗", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [
        {
          missionIdentifier: "mission-1",
          toolName: "readFile",
          kind: "failure",
          recordedAtIso: "2026-11-28T10:00:00.000Z",
          failureReason: "a",
        },
        {
          missionIdentifier: "mission-2",
          toolName: "readFile",
          kind: "failure",
          recordedAtIso: "2026-11-28T10:00:01.000Z",
          failureReason: "b",
        },
        {
          missionIdentifier: "mission-2",
          toolName: "readFile",
          kind: "success",
          recordedAtIso: "2026-11-28T10:00:02.000Z",
        },
        {
          missionIdentifier: "mission-1",
          toolName: "readFile",
          kind: "success",
          recordedAtIso: "2026-11-28T10:00:03.000Z",
        },
      ],
      usageObservations: [
        usage("2026-11-28T10:00:01.500Z", 4, 4, "mission-2"),
        usage("2026-11-28T10:00:02.500Z", 6, 6, "mission-1"),
      ],
    });
    expect(report.traces).toHaveLength(2);
    const mission2 = report.traces.find((trace) => trace.missionIdentifier === "mission-2");
    const mission1 = report.traces.find((trace) => trace.missionIdentifier === "mission-1");
    expect(mission2?.totalTokenCount).toBe(8);
    expect(mission1?.totalTokenCount).toBe(12);
  });

  it("⑧ 没有失败时普通成功调用：不产 trace、不报错，且无法归属 mission 的用量被跳过", () => {
    const report = buildToolFailureTokenTraces({
      toolEvents: [success("2026-11-28T10:00:00.000Z")],
      usageObservations: [usage("2026-11-28T10:00:01.000Z", 3, 3, null)],
    });
    expect(report.traces).toEqual([]);
    expect(report.openWindowCount).toBe(0);
    expect(report.skippedEventCount).toBe(1);
  });
});

describe("TOKTRACE-01：运行历史工具活动提取", () => {
  it("⑨ 只取 tool-call/tool-failure；损坏 payload 计数跳过", () => {
    const extracted = extractToolActivityEvents({
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
              recordedAtIso: "2026-11-28T10:01:00.000Z",
              payloadJson: JSON.stringify({ toolName: "readFile", outputText: "ok" }),
            },
            {
              kind: "model-note",
              recordedAtIso: "2026-11-28T10:02:00.000Z",
              payloadJson: JSON.stringify({ text: "忽略" }),
            },
            {
              kind: "tool-failure",
              recordedAtIso: "2026-11-28T10:03:00.000Z",
              payloadJson: "{bad json",
            },
            {
              kind: "tool-call",
              recordedAtIso: "2026-11-28T10:04:00.000Z",
              payloadJson: JSON.stringify({ outputText: "缺工具名" }),
            },
          ],
        },
      ],
    });
    expect(extracted.events).toHaveLength(2);
    expect(extracted.events[0]).toMatchObject({ kind: "failure", toolName: "readFile" });
    expect(extracted.events[1]).toMatchObject({ kind: "success", toolName: "readFile" });
    expect(extracted.skippedEventCount).toBe(2);
  });
});
