/**
 * `run` 采集接线的反例（2026-10-19 R68）。
 *
 * 决策：只接 `run`、`--perf-collect`、**默认 off**（不传开关时零开销、不建目录）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareRunPerfCollection } from "../../../packages/core/src/orchestration/run-perf-collection.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-run-perf-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fakeTimerPort() {
  const callbacks = new Map<unknown, () => void>();
  let nextHandle = 1;
  return {
    setInterval: (callback: () => void) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    clearInterval: (handle: unknown) => {
      callbacks.delete(handle);
    },
    activeHandles: () => callbacks.size,
  };
}

describe("run 采集接线", () => {
  it("① 默认未开启 ⇒ 返回 null，且不创建 perf 目录（零开销）", async () => {
    const collector = prepareRunPerfCollection({
      stateDirectory,
      isPerfCollectionEnabled: false,
      agentInstanceIdentifier: "agent-1",
      readProcessMetrics: () => ({ residentMemoryBytes: 1024 }),
    });
    expect(collector).toBeNull();
    await expect(fs.access(path.join(stateDirectory, "perf"))).rejects.toThrow();
  });

  it("② 开启 ⇒ 返回未启动的采集器；start 后按 tick 落盘；stop 后清理", async () => {
    const timerPort = fakeTimerPort();
    const collector = prepareRunPerfCollection({
      stateDirectory,
      isPerfCollectionEnabled: true,
      agentInstanceIdentifier: "agent-1",
      readProcessMetrics: () => ({ residentMemoryBytes: 2048 }),
      schedulingTimerPort: timerPort,
    });
    if (collector === null) throw new Error("应创建采集器");
    // 创建时**不自动 start**（由调用方在会话开始处显式启动）
    expect(collector.isRunning()).toBe(false);
    expect(timerPort.activeHandles()).toBe(0);

    expect(collector.start().kind).toBe("started");
    expect(timerPort.activeHandles()).toBe(1);
    expect((await collector.sampleNow()).kind).toBe("sampled");

    const stopOutcome = await collector.stop();
    expect(stopOutcome.kind).toBe("stopped");
    expect(timerPort.activeHandles()).toBe(0);
    // 样本确实落到了 perf/process-samples.jsonl
    const written = await fs.readFile(
      path.join(stateDirectory, "perf", "process-samples.jsonl"),
      "utf8",
    );
    expect(written).toContain("\"eventType\":\"process\"");
    expect(written).toContain("2048");
  });
});
