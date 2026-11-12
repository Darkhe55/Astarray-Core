/**
 * CLUSTER-01 §5：**SDK 入口**验收——经 `AstarrayApplicationFacade.create` 走通。
 *
 * 与 integration/cluster01-assembly-wiring 的分工：那边验的是 `createApplicationRuntime`，
 * 这边验的是**公开 SDK 门面**，即外部消费者真正能碰到的入口。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { toDiagnosticClusterInput } from "../../../packages/core/src/orchestration/diagnostic-clusterer.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-sdk-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
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
    messageText: "连接超时 timeout 重试",
    recoveryState: "unknown",
    classification: "transient",
    chain: { rootErrorCode: "E_TIMEOUT", wrapperErrorCodes: [] },
  } as never;
}

async function createFacade(isDiagnosticClusteringEnabled: boolean) {
  return await AstarrayApplicationFacade.create({
    mode: "assist",
    stateDirectory,
    authenticatedUserId: "user-1",
    isDiagnosticClusteringEnabled,
  } as never);
}

describe("CLUSTER-01 SDK 门面", () => {
  it("缺省关闭 ⇒ 构建与查询都返回 disabled，且不留目录", async () => {
    const facade = await createFacade(false);
    try {
      expect(
        await facade.buildDiagnosticClusterSnapshot({
          projectIdentifier: "project-alpha",
          /** 用当前时间：避免"写入当天才通过"的时间炸弹（TTL 24h）。 */
      generatedAtIso: new Date().toISOString(),
          resolveProjectIdentifier: () => "project-alpha",
        }),
      ).toEqual({ status: "disabled" });
      expect(await facade.getDiagnosticClusteringStatus("project-alpha")).toEqual({ status: "disabled" });
      await expect(fs.stat(path.join(stateDirectory, "analysis"))).rejects.toThrow();
    } finally {
      await facade.shutdown?.().catch(() => undefined);
    }
  }, 60_000);

  it("开启 ⇒ 门面可构建快照并检索相似案例", async () => {
    const facade = await createFacade(true);
    try {
      expect(await facade.getDiagnosticClusteringStatus("project-alpha")).toEqual({ status: "no-snapshot" });
      const built = await facade.buildDiagnosticClusterSnapshot({
        projectIdentifier: "project-alpha",
        /** 用当前时间：避免"写入当天才通过"的时间炸弹（TTL 24h）。 */
      generatedAtIso: new Date().toISOString(),
        resolveProjectIdentifier: () => "project-alpha",
      });
      expect(built.status).toBe("built");

      const related = await facade.findRelatedDiagnosticCases({
        projectIdentifier: "project-alpha",
        event: toDiagnosticClusterInput(buildEvent(1), "project-alpha"),
      });
      expect(related.status).toBe("ready");
    } finally {
      await facade.shutdown?.().catch(() => undefined);
    }
  }, 60_000);
});
