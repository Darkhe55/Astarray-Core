/**
 * CLUSTER-01 §5 接线验收：从**真实应用装配入口**（`createApplicationRuntime`）可达。
 *
 * 两个必证的行为：
 * - 关闭（缺省）⇒ 服务可用但一律 `disabled`，且**不产生任何文件痕迹**；
 * - 开启 ⇒ 能构建快照、能检索相似案例。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { toDiagnosticClusterInput } from "../../../packages/core/src/orchestration/diagnostic-clusterer.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-wiring-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createRuntime(isDiagnosticClusteringEnabled: boolean) {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    isDiagnosticClusteringEnabled,
    workerRuntimeFactory: () => ({
      async *run() {
        yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
      },
    }),
  });
}

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

const indexRoot = () => path.join(stateDirectory, "analysis", "diagnostic-clusters");

describe("CLUSTER-01 装配接线", () => {
  it("缺省关闭 ⇒ 服务存在但返回 disabled，且不留文件痕迹", async () => {
    const runtime = await createRuntime(false);
    try {
      expect(runtime.diagnosticClusterService).toBeDefined();
      expect(runtime.diagnosticClusterService.isDiagnosticClusteringEnabled()).toBe(false);
      expect(await runtime.diagnosticClusterService.readLatest("project-alpha")).toEqual({ status: "disabled" });
      await expect(fs.stat(indexRoot())).rejects.toThrow();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("开启 ⇒ 从装配入口构建快照并可检索相似案例", async () => {
    const runtime = await createRuntime(true);
    try {
      const store = runtime.diagnosticClusterService;
      expect(store.isDiagnosticClusteringEnabled()).toBe(true);
      /** 未构建前必须是 no-snapshot，而不是空结果。 */
      expect(await store.readLatest("project-alpha")).toEqual({ status: "no-snapshot" });

      const built = await store.buildSnapshot({
        projectIdentifier: "project-alpha",
        generatedAtIso: "2026-11-11T00:00:00.000Z",
        resolveProjectIdentifier: () => "project-alpha",
      });
      expect(built.status).toBe("built");
      if (built.status !== "built") throw new Error("unreachable");
      expect(built.snapshot.isComplete).toBe(true);

      const related = await store.findRelated({
        projectIdentifier: "project-alpha",
        event: toDiagnosticClusterInput(buildEvent(1), "project-alpha"),
      });
      expect(related.status).toBe("ready");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
