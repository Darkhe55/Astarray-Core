/**
 * 进程样本落盘的反例（2026-10-19 R51）。
 *
 * 用户决策：进程样本用**独立事件类型 + 独立文件**，指标全部可选（unknown 不记作零）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProcessSampleStore,
  isProcessSampleEvent,
  type ProcessSampleEventV1,
} from "../../../packages/core/src/orchestration/process-sample-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-process-sample-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sample(overrides: Partial<ProcessSampleEventV1> = {}): ProcessSampleEventV1 {
  return {
    observeEventVersion: 1,
    eventType: "process",
    recordedAtIso: "2026-10-19T00:00:00.000Z",
    processIdentifier: 4242,
    agentInstanceIdentifier: "agent-1",
    fields: { residentMemoryBytes: 1024 },
    droppedSampleCount: 0,
    ...overrides,
  };
}

describe("进程样本落盘（独立事件类型 + 独立文件）", () => {
  it("① 追加后读回：独立文件、字段原样、不与业务样本混在一起", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sample({ fields: { residentMemoryBytes: 2048, queueDepth: 0 } }));
    const report = await store.readWithIntegrity();
    expect(report.discardedLineCount).toBe(0);
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0]?.fields.residentMemoryBytes).toBe(2048);
    expect(report.samples[0]?.fields.queueDepth).toBe(0);
    // 写的是 perf/process-samples.jsonl，而不是 perf/samples.jsonl
    await expect(
      fs.readFile(path.join(baseDirectory, "perf", "process-samples.jsonl"), "utf8"),
    ).resolves.toContain("\"eventType\":\"process\"");
    await expect(fs.access(path.join(baseDirectory, "perf", "samples.jsonl"))).rejects.toThrow();
  });

  it("② 指标可缺省（unknown 不记作零）：只写拿到的字段", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sample({ fields: {} }));
    const report = await store.readWithIntegrity();
    expect(report.samples[0]?.fields).toEqual({});
    expect(Object.hasOwn(report.samples[0]?.fields ?? {}, "eventLoopDelayMs")).toBe(false);
  });

  it("③ 非法样本拒绝写入（白名单外字段/负数/NaN/未知事件类型）", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await expect(
      store.append(sample({ fields: { cpuPercent: 42 } as never })),
    ).rejects.toThrow(/非法的进程样本/);
    await expect(store.append(sample({ fields: { taskDurationMs: -1 } }))).rejects.toThrow();
    await expect(
      store.append(sample({ fields: { eventLoopDelayMs: Number.NaN } })),
    ).rejects.toThrow();
    await expect(
      store.append(sample({ eventType: "perf" as never })),
    ).rejects.toThrow();
    expect((await store.readWithIntegrity()).samples).toHaveLength(0);
  });

  it("④ 坏行如实计数（不静默丢弃、不当作零样本）", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sample());
    const filePath = path.join(baseDirectory, "perf", "process-samples.jsonl");
    await fs.appendFile(filePath, "{ not json\n{\"eventType\":\"widget\"}\n", "utf8");

    const report = await store.readWithIntegrity();
    expect(report.samples).toHaveLength(1);
    expect(report.discardedLineCount).toBe(2);
  });

  it("⑤ 丢样计数被持久化（观测降级可追溯）", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    await store.append(sample({ droppedSampleCount: 7 }));
    const report = await store.readWithIntegrity();
    expect(report.samples[0]?.droppedSampleCount).toBe(7);
  });

  it("⑥ 文件不存在 ⇒ 空结果且丢弃数为 0（不是报错）", async () => {
    const store = new ProcessSampleStore({ baseDirectory });
    expect(await store.readWithIntegrity()).toEqual({ samples: [], discardedLineCount: 0 });
  });

  it("⑦ 校验函数：合法样本通过，字段带未知键或类型错误一律不通过", () => {
    expect(isProcessSampleEvent(sample())).toBe(true);
    expect(isProcessSampleEvent(sample({ fields: { extra: 1 } as never }))).toBe(false);
    expect(isProcessSampleEvent(sample({ recordedAtIso: "not-a-date" }))).toBe(false);
    expect(isProcessSampleEvent(sample({ processIdentifier: -1 }))).toBe(false);
  });
});
