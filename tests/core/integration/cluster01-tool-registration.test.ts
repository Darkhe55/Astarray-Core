/**
 * CLUSTER-01 §5：工具注册的开关语义（经真实装配入口）。
 *
 * 之前的失败原因已定位：注册表会拒绝**未映射权限能力**的工具
 * （`工具 X 未映射任何可配置权限，拒绝注册`），
 * 因此先补齐 `diagnostic.clusters.read` / `diagnostic.clusters.build` 两个能力与映射。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { DIAGNOSTIC_CLUSTER_TOOL_NAME } from "../../../packages/core/src/orchestration/diagnostic-cluster-tools.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-registry-"));
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

describe("CLUSTER-01 工具注册", () => {
  it("**开启** ⇒ 工具已注册", async () => {
    const runtime = await createRuntime(true);
    try {
      expect(runtime.listRegisteredToolNames()).toContain(DIAGNOSTIC_CLUSTER_TOOL_NAME);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("**关闭** ⇒ 工具从不注册（不是「注册后拒绝」）", async () => {
    const runtime = await createRuntime(false);
    try {
      expect(runtime.listRegisteredToolNames()).not.toContain(DIAGNOSTIC_CLUSTER_TOOL_NAME);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
