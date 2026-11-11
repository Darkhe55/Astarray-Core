/**
 * CLUSTER-01 §4：构建器的边界行为。
 *
 * 反例重点：**命中上限必须返回 partial 并写明原因**，不得声称覆盖全部历史；
 * 归属无法证明的记录必须被排除并计数（不能混进项目分析）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDiagnosticClusterSnapshotForProject } from "../../../packages/core/src/orchestration/diagnostic-cluster-build.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-build-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildEvent(index: number, overrides: Record<string, unknown> = {}) {
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: `2026-11-11T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
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
    messageText: `连接超时 timeout ${String(index)}`,
    recoveryState: "unknown",
    classification: "transient",
    chain: { rootErrorCode: "E_TIMEOUT", wrapperErrorCodes: [] },
    ...overrides,
  } as never;
}

describe("CLUSTER-01 构建器", () => {
  it("完整扫描 ⇒ isComplete=true 且无 partial 原因", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 5; index += 1) {
      await store.append(buildEvent(index));
    }
    const result = await buildDiagnosticClusterSnapshotForProject({
      store,
      stateDirectory,
      projectIdentifier: "project-alpha",
      algorithmVersion: "diagnostic-cluster-v1",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: () => "project-alpha",
    });
    expect(result.snapshot.isComplete).toBe(true);
    expect(result.partialReason).toBeNull();
    expect(result.scannedEventCount).toBe(5);
    expect(result.excludedRecordCount).toBe(0);
    expect(result.snapshot.groups.length).toBeGreaterThan(0);
  });

  it("命中事件上限 ⇒ partial=event-limit，且游标前移（可续扫）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 10; index += 1) {
      await store.append(buildEvent(index));
    }
    const result = await buildDiagnosticClusterSnapshotForProject({
      store,
      stateDirectory,
      projectIdentifier: "project-alpha",
      algorithmVersion: "diagnostic-cluster-v1",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: () => "project-alpha",
      limits: { maximumEventCount: 3, pageSize: 3 },
    });
    expect(result.snapshot.isComplete).toBe(false);
    expect(result.partialReason).toBe("event-limit");
    expect(result.snapshot.cursor.byteOffset).toBeGreaterThan(0);
  });

  it("归属无法证明的记录被排除并计数（不混进项目分析）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await store.append(buildEvent(1));
    await store.append(buildEvent(2, { requestIdentifier: "req-other" }));
    const result = await buildDiagnosticClusterSnapshotForProject({
      store,
      stateDirectory,
      projectIdentifier: "project-alpha",
      algorithmVersion: "diagnostic-cluster-v1",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: (event) =>
        (event as unknown as { requestIdentifier: string }).requestIdentifier === "req-other" ? null : "project-alpha",
    });
    expect(result.scannedEventCount).toBe(1);
    expect(result.excludedRecordCount).toBe(1);
  });

  it("命中时长上限 ⇒ partial=duration-limit", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 5; index += 1) {
      await store.append(buildEvent(index));
    }
    let tick = 0;
    const result = await buildDiagnosticClusterSnapshotForProject({
      store,
      stateDirectory,
      projectIdentifier: "project-alpha",
      algorithmVersion: "diagnostic-cluster-v1",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      resolveProjectIdentifier: () => "project-alpha",
      limits: { maximumDurationMilliseconds: 0 },
      nowMilliseconds: () => {
        tick += 1;
        return tick * 10;
      },
    });
    expect(result.snapshot.isComplete).toBe(false);
    expect(result.partialReason).toBe("duration-limit");
  });
});
