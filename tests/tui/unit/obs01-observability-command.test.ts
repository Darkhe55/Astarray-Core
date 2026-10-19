/**
 * `obs perf` / `obs diag` 只读查询入口的反例（2026-10-19 R38）。
 *
 * 用户 2026-10-19 决策（按推荐）：CLI `--json` 只读可查；**观测故障降级并报告、不阻塞业务**；
 * **"没有样本" ≠ "用量为零"**（卡内：unknown 不记作零）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DiagnosticEventStore,
  PerfEventStore,
  ProcessSampleStore,
} from "../../../packages/core/src/public-sdk.js";
import {
  executeObsDiagCommand,
  executeObsDiagExportCommand,
  executeObsPerfCommand,
  executeObsProcessCommand,
} from "../../../packages/tui/src/cli/observability-command.js";

let stateDirectory: string;
let stdoutText: string;
let stderrText: string;

function perfSample(overrides: Record<string, unknown> = {}) {
  return {
    observeEventVersion: 1 as const,
    eventType: "perf" as const,
    recordedAtIso: "2026-10-19T00:00:00.000Z",
    sourceAgentInstanceId: "agent-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    requestIdentifier: "request-1",
    requestRevision: 1,
    origin: { kind: "system" as const },
    operationKind: "tool-call",
    durationMilliseconds: 120,
    outcome: "success" as const,
    ...overrides,
  };
}

function diagnosticEvent(overrides: Record<string, unknown> = {}) {
  return {
    observeEventVersion: 1 as const,
    eventType: "diagnostic" as const,
    recordedAtIso: "2026-10-19T00:00:00.000Z",
    sourceAgentInstanceId: "agent-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    requestIdentifier: "request-1",
    requestRevision: 1,
    origin: { kind: "system" as const },
    errorCode: "PERMISSION_DENIED",
    stage: "tool" as const,
    severity: "error" as const,
    component: "tool-gate",
    messageText: "权限不足（已脱敏）",
    recoveryState: "blocked-uncertain" as const,
    classification: "deterministic-fact" as const,
    chain: { rootErrorCode: "PERMISSION_DENIED", wrapperErrorCodes: [] },
    ...overrides,
  };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-obs-cli-"));
  stdoutText = "";
  stderrText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrText += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("OBS 只读查询入口", () => {
  it("① 无样本 ⇒ kind=ok、hasSamples=false，且**不把空结果说成用量为零**", async () => {
    const exitCode = await executeObsPerfCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      hasSamples: boolean;
      notice: string | null;
      coverage: { matchedSampleCount: number };
    };
    expect(payload.kind).toBe("ok");
    expect(payload.hasSamples).toBe(false);
    expect(payload.coverage.matchedSampleCount).toBe(0);
    expect(String(payload.notice)).toContain("不代表用量为零");
  });

  it("② 有样本 ⇒ 覆盖范围回显、明细分页可用、时间窗真实生效", async () => {
    const store = new PerfEventStore({ baseDirectory: stateDirectory });
    await store.append(perfSample({ recordedAtIso: "2026-10-19T00:00:00.000Z" }));
    await store.append(
      perfSample({ recordedAtIso: "2026-10-19T02:00:00.000Z", requestIdentifier: "request-2" }),
    );

    const all = await executeObsPerfCommand({
      stateDirectory,
      isJsonOutput: true,
      detailLevel: "detail",
      pageSize: 1,
    });
    expect(all).toBe(0);
    const allPayload = JSON.parse(stdoutText) as {
      hasSamples: boolean;
      coverage: { matchedSampleCount: number; totalSampleCount: number };
      page: { samples: unknown[]; nextCursor: string | null };
    };
    expect(allPayload.hasSamples).toBe(true);
    expect(allPayload.coverage.matchedSampleCount).toBe(2);
    expect(allPayload.coverage.totalSampleCount).toBe(2);
    expect(allPayload.page.samples).toHaveLength(1);
    expect(allPayload.page.nextCursor).not.toBeNull();

    stdoutText = "";
    await executeObsPerfCommand({
      stateDirectory,
      isJsonOutput: true,
      detailLevel: "detail",
      windowStartIso: "2026-10-19T01:00:00.000Z",
    });
    const filtered = JSON.parse(stdoutText) as { coverage: { matchedSampleCount: number } };
    expect(filtered.coverage.matchedSampleCount).toBe(1);
  });

  it("③ 诊断事件：按指纹聚合、事实与推断分列、可按具体个体过滤", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await store.append(diagnosticEvent());
    await store.append(
      diagnosticEvent({ sourceAgentInstanceId: "agent-2", requestIdentifier: "request-2" }),
    );

    const exitCode = await executeObsDiagCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      hasFindings: boolean;
      coverage: { matchedEventCount: number; totalEventCount: number };
      deterministicFindings: unknown[];
      suspectedFindings: unknown[];
      isReportable: boolean;
    };
    expect(payload.kind).toBe("ok");
    expect(payload.hasFindings).toBe(true);
    expect(payload.coverage.totalEventCount).toBe(2);
    expect(payload.deterministicFindings.length).toBeGreaterThan(0);
    expect(payload.suspectedFindings).toHaveLength(0);

    stdoutText = "";
    await executeObsDiagCommand({
      stateDirectory,
      isJsonOutput: true,
      sourceAgentInstanceId: "agent-1",
    });
    const filtered = JSON.parse(stdoutText) as { coverage: { matchedEventCount: number } };
    // 子 Agent 不得借诊断接口读取同级记录：过滤后只应剩该个体的 1 条
    expect(filtered.coverage.matchedEventCount).toBe(1);
  });

  it("④ 坏行 ⇒ 显式报告丢弃行数（不静默当零）", async () => {
    const perfDirectory = path.join(stateDirectory, "perf");
    await fs.mkdir(perfDirectory, { recursive: true });
    await fs.writeFile(path.join(perfDirectory, "samples.jsonl"), "{ not jsonl\n", "utf8");

    const exitCode = await executeObsPerfCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      hasSamples: boolean;
      coverage: { matchedSampleCount: number; discardedLineCount: number };
    };
    expect(payload.kind).toBe("ok");
    expect(payload.hasSamples).toBe(false);
    expect(payload.coverage.discardedLineCount).toBeGreaterThan(0);
  });

  it("⑤ 真实读取失败（受控注入）⇒ 降级并报告（exit 0），不把观测故障抛给调用方", async () => {
    /**
     * 为什么用 mock：把样本路径做成目录（EISDIR）时，store 会把它折算成"丢弃行"而**不抛错**，
     * 于是测不到入口的 catch 降级分支（变异体会假存活）。这里直接注入一次 I/O 失败。
     */
    const readSpy = vi
      .spyOn(PerfEventStore.prototype, "readWithIntegrity")
      .mockRejectedValueOnce(new Error("模拟磁盘读取失败"));

    const exitCode = await executeObsPerfCommand({ stateDirectory, isJsonOutput: true });
    readSpy.mockRestore();
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      hasSamples: boolean;
      reason?: string;
    };
    expect(payload.kind).toBe("degraded");
    expect(payload.hasSamples).toBe(false);
    expect(String(payload.reason)).toContain("查询失败");
    expect(stderrText.length).toBe(0);
  });

  it("⑥ obs process：无样本 ⇒ hasSamples=false 且明确「不代表没有资源消耗」", async () => {
    const exitCode = await executeObsProcessCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      hasSamples: boolean;
      notice: string | null;
      coverage: { discardedLineCount: number; droppedSampleCountTotal: number };
    };
    expect(payload.kind).toBe("ok");
    expect(payload.hasSamples).toBe(false);
    expect(String(payload.notice)).toContain("不代表没有资源消耗");
    expect(payload.coverage.discardedLineCount).toBe(0);
    expect(payload.coverage.droppedSampleCountTotal).toBe(0);
  });

  it("⑦ obs process：坏行如实计数、时间窗与 limit 生效、丢样累计可见", async () => {
    const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-10-19T00:00:00.000Z",
      processIdentifier: 1,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 1024 },
      droppedSampleCount: 2,
    });
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-10-19T02:00:00.000Z",
      processIdentifier: 1,
      agentInstanceIdentifier: "agent-1",
      fields: { queueDepth: 3 },
      droppedSampleCount: 1,
    });
    const filePath = path.join(stateDirectory, "perf", "process-samples.jsonl");
    await fs.appendFile(filePath, "{ broken line\n", "utf8");

    stdoutText = "";
    await executeObsProcessCommand({
      stateDirectory,
      isJsonOutput: true,
      windowStartIso: "2026-10-19T01:00:00.000Z",
      limit: 1,
    });
    const filtered = JSON.parse(stdoutText) as {
      hasSamples: boolean;
      samples: unknown[];
      coverage: {
        totalSampleCount: number;
        matchedSampleCount: number;
        returnedSampleCount: number;
        discardedLineCount: number;
        droppedSampleCountTotal: number;
      };
    };
    expect(filtered.hasSamples).toBe(true);
    expect(filtered.coverage.totalSampleCount).toBe(2);
    expect(filtered.coverage.matchedSampleCount).toBe(1);
    expect(filtered.coverage.returnedSampleCount).toBe(1);
    expect(filtered.samples).toHaveLength(1);
    // 坏行必须如实计数（不得静默当 0）
    expect(filtered.coverage.discardedLineCount).toBe(1);
    // 丢样累计跨样本求和（观测降级可追溯）
    expect(filtered.coverage.droppedSampleCountTotal).toBe(3);
  });

  it("⑧ obs process --summary：只给聚合（逐字段分母/缺字段 null），且**遵守时间窗**", async () => {
    const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-10-19T00:00:00.000Z",
      processIdentifier: 1,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 100 },
      droppedSampleCount: 0,
    });
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-10-19T02:00:00.000Z",
      processIdentifier: 1,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 300, queueDepth: 5 },
      droppedSampleCount: 0,
    });

    stdoutText = "";
    await executeObsProcessCommand({
      stateDirectory,
      isJsonOutput: true,
      summarize: true,
      windowStartIso: "2026-10-19T01:00:00.000Z",
    });
    const payload = JSON.parse(stdoutText) as {
      hasSamples: boolean;
      samples: unknown[];
      aggregate: {
        sampleCount: number;
        earliestRecordedAtIso: string | null;
        fields: {
          residentMemoryBytes: { sampleCount: number; mean: number | null };
          eventLoopDelayMs: { sampleCount: number; mean: number | null };
        };
      };
    };
    // 摘要模式不返回逐条样本
    expect(payload.samples).toHaveLength(0);
    expect(payload.aggregate).not.toBeNull();
    // **遵守时间窗**：只统计 01:00 之后那条（300）
    expect(payload.aggregate.sampleCount).toBe(1);
    expect(payload.aggregate.fields.residentMemoryBytes.sampleCount).toBe(1);
    expect(payload.aggregate.fields.residentMemoryBytes.mean).toBe(300);
    expect(payload.aggregate.earliestRecordedAtIso).toBe("2026-10-19T02:00:00.000Z");
    // 该窗口内没有事件循环延迟样本 ⇒ null（unknown 不记作零）
    expect(payload.aggregate.fields.eventLoopDelayMs.sampleCount).toBe(0);
    expect(payload.aggregate.fields.eventLoopDelayMs.mean).toBeNull();
  });

  it("⑨ obs diag export：允许时写文件且未上传；缺窗口/未知章节时**不写文件**", async () => {
    const outputFilePath = path.join(stateDirectory, "evidence-pack.json");
    const exitCode = await executeObsDiagExportCommand({
      stateDirectory,
      outputFilePath,
      windowStartIso: "2026-10-19T00:00:00.000Z",
      windowEndIso: "2026-10-19T12:00:00.000Z",
      sections: ["findings-summary", "coverage-window"],
      astarrayVersion: "0.1.0",
      platform: "win32-x64",
      redactionSummary: "已脱敏：移除原始参数与凭据。",
      isUserInitiated: true,
      generatedAtIso: "2026-10-19T12:00:00.000Z",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      isAutoUploaded: boolean;
      manifest: { isAutoUploaded: boolean; sections: string[]; platform: string };
    };
    expect(payload.kind).toBe("exported");
    // **不联网上传**必须如实为 false
    expect(payload.isAutoUploaded).toBe(false);
    expect(payload.manifest.isAutoUploaded).toBe(false);
    expect(payload.manifest.sections).toEqual(["findings-summary", "coverage-window"]);
    const writtenText = await fs.readFile(outputFilePath, "utf8");
    expect(writtenText).toContain("已脱敏");

    // 缺时间窗 ⇒ 拒绝且**不写文件**
    const rejectedOutputPath = path.join(stateDirectory, "rejected-pack.json");
    stdoutText = "";
    const rejectedExitCode = await executeObsDiagExportCommand({
      stateDirectory,
      outputFilePath: rejectedOutputPath,
      windowStartIso: "",
      windowEndIso: "2026-10-19T12:00:00.000Z",
      sections: ["findings-summary"],
      astarrayVersion: "0.1.0",
      platform: "win32-x64",
      redactionSummary: "已脱敏",
      isUserInitiated: true,
      generatedAtIso: "2026-10-19T12:00:00.000Z",
      isJsonOutput: true,
    });
    expect(rejectedExitCode).toBe(1);
    await expect(fs.access(rejectedOutputPath)).rejects.toThrow();
    expect(stderrText).toContain("证据包导出被拒绝");

    // 未知章节 ⇒ 同样拒绝且不写文件
    stderrText = "";
    const unknownSectionExitCode = await executeObsDiagExportCommand({
      stateDirectory,
      outputFilePath: path.join(stateDirectory, "unknown-section-pack.json"),
      windowStartIso: "2026-10-19T00:00:00.000Z",
      windowEndIso: "2026-10-19T12:00:00.000Z",
      sections: ["raw-logs"],
      astarrayVersion: "0.1.0",
      platform: "win32-x64",
      redactionSummary: "已脱敏",
      isUserInitiated: true,
      generatedAtIso: "2026-10-19T12:00:00.000Z",
      isJsonOutput: true,
    });
    expect(unknownSectionExitCode).toBe(1);
    await expect(
      fs.access(path.join(stateDirectory, "unknown-section-pack.json")),
    ).rejects.toThrow();
  });

  it("⑩ obs diag export 正文：只写指纹级聚合（不含错误文本）、遵守时间窗", async () => {
    const diagnosticStore = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await diagnosticStore.append({
      observeEventVersion: 1,
      eventType: "diagnostic",
      recordedAtIso: "2026-10-19T02:00:00.000Z",
      sourceAgentInstanceId: "agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      requestIdentifier: "request-in-window",
      requestRevision: 1,
      origin: { kind: "system" },
      errorCode: "PERMISSION_DENIED",
      stage: "tool",
      severity: "error",
      component: "tool-gate",
      messageText: "SECRET_MARKER_原始错误文本",
      recoveryState: "blocked-uncertain",
      classification: "deterministic-fact",
      chain: { rootErrorCode: "PERMISSION_DENIED", wrapperErrorCodes: [] },
    });
    await diagnosticStore.append({
      observeEventVersion: 1,
      eventType: "diagnostic",
      recordedAtIso: "2026-10-18T02:00:00.000Z",
      sourceAgentInstanceId: "agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      requestIdentifier: "request-outside-window",
      requestRevision: 1,
      origin: { kind: "system" },
      errorCode: "TOOL_FAILED",
      stage: "tool",
      severity: "error",
      component: "tool-runner",
      messageText: "OUT_OF_WINDOW_MARKER",
      recoveryState: "blocked-uncertain",
      classification: "deterministic-fact",
      chain: { rootErrorCode: "TOOL_FAILED", wrapperErrorCodes: [] },
    });

    const outputFilePath = path.join(stateDirectory, "evidence-body.json");
    const exitCode = await executeObsDiagExportCommand({
      stateDirectory,
      outputFilePath,
      windowStartIso: "2026-10-19T00:00:00.000Z",
      windowEndIso: "2026-10-19T12:00:00.000Z",
      sections: ["findings-summary", "coverage-window"],
      astarrayVersion: "0.1.0",
      platform: "win32-x64",
      redactionSummary: "已脱敏：移除原始参数、错误文本与凭据。",
      isUserInitiated: true,
      generatedAtIso: "2026-10-19T12:00:00.000Z",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);

    const written = await fs.readFile(outputFilePath, "utf8");
    const pack = JSON.parse(written) as {
      manifest: { isAutoUploaded: boolean };
      body: {
        coverage: { matchedEventCount: number };
        findings: Array<{ fingerprint: string; occurrenceCount: number }>;
      };
    };
    // 只统计窗口内那一条
    expect(pack.body.coverage.matchedEventCount).toBe(1);
    expect(pack.body.findings).toHaveLength(1);
    expect(pack.body.findings[0]?.fingerprint.length).toBeGreaterThan(0);
    // **绝不写入原始错误文本**（无论窗口内外）
    expect(written).not.toContain("SECRET_MARKER_原始错误文本");
    expect(written).not.toContain("OUT_OF_WINDOW_MARKER");
    expect(pack.manifest.isAutoUploaded).toBe(false);
  });
});





