/**
 * CLUSTER-01 §4：租约、取消与 TTL 三条边界。
 *
 * 反例重点：
 * - 同一项目并发 build ⇒ `busy`（不得两批扫描同时写索引）；
 * - 取消 ⇒ partial 且**保存游标**（可续扫，不丢进度）；
 * - 超过 TTL ⇒ `stale`（不静默当新结果，也不自动重建）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticClusterService } from "../../../packages/core/src/orchestration/diagnostic-cluster-service.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-lease-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildEvent(index: number) {
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: `2026-11-11T00:00:0${String(index)}.000Z`,
    sourceAgentInstanceId: "worker-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    requestIdentifier: `req-${String(index)}`,
    requestRevision: 1,
    origin: { kind: "provider" },
    errorCode: "E_TIMEOUT",
    stage: "execute",
    severity: "error",
    component: "worker",
    messageText: "连接超时 timeout",
    recoveryState: "unknown",
    classification: "transient",
    chain: { rootErrorCode: "E_TIMEOUT", wrapperErrorCodes: [] },
  } as never;
}

function buildService(nowMilliseconds?: () => number) {
  return new DiagnosticClusterService({
    store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
    stateDirectory,
    algorithmVersion: "diagnostic-cluster-v1",
    isEnabled: true,
    ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
  });
}

describe("CLUSTER-01 租约 / 取消 / TTL", () => {
  it("同一项目并发 build ⇒ 第二个返回 busy（不并行写索引）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 5; index += 1) await store.append(buildEvent(index));
    const service = buildService();
    const input = {
      projectIdentifier: "project-alpha",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: () => "project-alpha",
    };
    const [first, second] = await Promise.all([service.buildSnapshot(input), service.buildSnapshot(input)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["built", "busy"]);
  });

  it("取消信号 ⇒ partial=cancelled 且保存游标", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 5; index += 1) await store.append(buildEvent(index));
    const service = buildService();
    const controller = new AbortController();
    controller.abort();
    const built = await service.buildSnapshot({
      projectIdentifier: "project-alpha",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: () => "project-alpha",
      signal: controller.signal,
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("unreachable");
    expect(built.snapshot.isComplete).toBe(false);
    expect(built.partialReason).toBe("cancelled");
    expect(built.snapshot.cursor.byteOffset).toBeGreaterThanOrEqual(0);
  });

  it("超过 TTL ⇒ stale（不静默当新结果）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await store.append(buildEvent(1));
    /** 固定时钟：让"未过期 ⇒ ready"与真实日期解耦（否则过期日一过测试必红）。 */
    const oldService = buildService(() => Date.parse("2026-11-11T01:00:00.000Z"));
    await oldService.buildSnapshot({
      projectIdentifier: "project-alpha",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: () => "project-alpha",
    });
    /** 把"现在"推到 25 小时之后（TTL 默认 24 小时）。 */
    const futureService = new DiagnosticClusterService({
      store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
      isEnabled: true,
      nowMilliseconds: () => Date.parse("2026-11-12T02:00:00.000Z"),
    });
    const latest = await futureService.readLatest("project-alpha");
    expect(latest.status).toBe("stale");
    /** 未过期时仍是 ready（同一份快照）。 */
    expect((await oldService.readLatest("project-alpha")).status).toBe("ready");
  });
});
