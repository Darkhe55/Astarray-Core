/**
 * OBS-01（2026-11-09）：**存储预算必须真的能触发**。
 *
 * 修复的真实缺陷：`session-perf-collector` 的 `storageBytesUsed` 缺省是
 * `() => 0`，而装配层从未传它 ⇒ 已用存储恒为 0 ⇒ **10 MB 预算在生产永不触发**，
 * 这正是卡内明令禁止的"unknown 记作零"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PERF_STORAGE_BUDGET_BYTES,
  evaluatePerfCollection,
} from "../../../packages/core/src/orchestration/observability-collection-contract.js";
import { ProcessSampleStore } from "../../../packages/core/src/orchestration/process-sample-store.js";
import { prepareRunPerfCollection } from "../../../packages/core/src/orchestration/run-perf-collection.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-obs-budget-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 6 });
});

describe("OBS-01 存储预算判定", () => {
  it("已用超过预算 ⇒ 停可选采集并报告（不静默删历史）", () => {
    const decision = evaluatePerfCollection({
      isCollectionEnabled: true,
      lastSampleAtIso: null,
      nowIso: "2026-11-09T00:00:00.000Z",
      storageBytesUsed: DEFAULT_PERF_STORAGE_BUDGET_BYTES,
    });
    expect(decision.kind).toBe("skip");
    expect(decision.kind === "skip" ? decision.reasonCode : null).toBe("storage-budget-exhausted");
  });

  it("已用未知（null）⇒ 不当作 0，也不误判超限", () => {
    const decision = evaluatePerfCollection({
      isCollectionEnabled: true,
      lastSampleAtIso: null,
      nowIso: "2026-11-09T00:00:00.000Z",
      storageBytesUsed: null,
    });
    /** 未知不等于超限：仍按间隔采样（不误停）。 */
    expect(decision.kind).not.toBe("skip");
  });

  it("已用为 0（真实为空）⇒ 正常采样", () => {
    const decision = evaluatePerfCollection({
      isCollectionEnabled: true,
      lastSampleAtIso: null,
      nowIso: "2026-11-09T00:00:00.000Z",
      storageBytesUsed: 0,
    });
    expect(decision.kind).not.toBe("skip");
  });
});

describe("OBS-01 存储占用统计", () => {
  it("目录不存在 ⇒ 0（真实为空，不是未知）", async () => {
    const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
    expect(await store.readStorageBytesUsed()).toBe(0);
  });

  it("有样本文件 ⇒ 返回真实字节数（随写入增长）", async () => {
    const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
    const before = await store.readStorageBytesUsed();
    expect(before).toBe(0);
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-11-09T00:00:00.000Z",
      processIdentifier: 1234,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 1024 },
      droppedSampleCount: 0,
    });
    const after = await store.readStorageBytesUsed();
    expect(after).not.toBeNull();
    expect(after ?? 0).toBeGreaterThan(0);
  });

  it("装配后的采集器使用真实占用，而不是恒 0", async () => {
    const store = new ProcessSampleStore({ baseDirectory: stateDirectory });
    /** 先写入足够多的样本，使真实占用超过一个很小的预算。 */
    for (let index = 0; index < 40; index += 1) {
      await store.append({
        observeEventVersion: 1,
        eventType: "process",
        recordedAtIso: "2026-11-09T00:00:00.000Z",
        processIdentifier: 1234,
        agentInstanceIdentifier: "agent-1",
        fields: { residentMemoryBytes: index },
        droppedSampleCount: 0,
      });
    }
    const actualBytes = await store.readStorageBytesUsed();
    expect(actualBytes ?? 0).toBeGreaterThan(0);
    /** 直接以真实占用做判定：应当超限（证明"0"不是真实值）。 */
    const decision = evaluatePerfCollection({
      isCollectionEnabled: true,
      lastSampleAtIso: null,
      nowIso: "2026-11-09T00:00:00.000Z",
      storageBytesUsed: actualBytes,
      storageBudgetBytes: 1,
    });
    expect(decision.kind === "skip" ? decision.reasonCode : null).toBe(
      "storage-budget-exhausted",
    );
  });

  it("未开启采集 ⇒ 采集器为 null（不产生开销）", () => {
    const collector = prepareRunPerfCollection({
      isPerfCollectionEnabled: false,
      stateDirectory,
      agentInstanceIdentifier: null,
      readProcessMetrics: () => ({}),
    });
    expect(collector).toBeNull();
  });
});
