/**
 * AUDIT-REPAIR-01 检查点 04（2026-11-06）：工具说明回访的生产入口。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

async function createHarness(options: { withRegistry?: boolean } = {}) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-tool-help-"));
  directories.push(stateDirectory);
  const streamed: string[] = [];
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: (_missionId, text) => {
      streamed.push(text);
    },
    ...(options.withRegistry === false
      ? {}
      : {
          toolDocumentationRegistry: {
            readFile: {
              examples: ['{"filePath":"README.md"}'],
              failureCodes: ["file-not-found"],
              returnSchemaJson: '{"type":"object"}',
              requiredCapabilities: ["project.read"],
              limitations: ["只能读取工作区内文件"],
            },
          },
        }),
  });
  await runtime.missionManager.createMission({
    missionId: "mission-help",
    mode: "assist",
    prompt: "帮助请求",
    taskNodes: [
      {
        id: "T-001",
        description: "帮助请求",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile", "createProjectFile"],
        assignedAgentId: "worker:mission-help:T-001",
        status: "running",
        resultLocation: null,
      },
    ],
  });
  return { runtime, streamed };
}

function usageHelpRequest(overrides: Record<string, unknown> = {}) {
  return {
    controlEventType: "ASTARRAY_TOOL_HELP_REQUEST_V1",
    requestIdentifier: "req-1",
    taskExecutionIdentifier: "task-exec:mission-help:T-001",
    requestKind: "usage-help",
    toolIdentifier: "readFile",
    capabilityIntent: "读取说明文件",
    blockingReason: "forgot-usage",
    knownToolGroupRevision: 1,
    ...overrides,
  };
}

describe("工具说明回访生产入口", () => {
  it("已分配工具 ⇒ usage-provided（不授予权限）", async () => {
    const { runtime } = await createHarness();
    try {
      const response = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest(),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(response.resolution).toBe("usage-provided");
      expect(response.usageDocumentation?.toolIdentifier).toBe("readFile");
      expect(response.isAuthorizationGranted).toBe(false);
      expect(response.toolDefinitionRevision).toBe(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("拔掉公开用法登记装配 ⇒ 已分配工具也退化为 known-but-not-usable（正向测试确实依赖接线）", async () => {
    const { runtime } = await createHarness({ withRegistry: false });
    try {
      const response = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest({ requestIdentifier: "req-unwired" }),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(response.resolution).toBe("known-but-not-usable");
      expect(response.usageDocumentation).toBeNull();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("未登记公开用法/未分配 ⇒ known-but-not-usable，且不泄露 schema", async () => {
    const { runtime, streamed } = await createHarness();
    try {
      const response = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest({
          requestIdentifier: "req-2",
          toolIdentifier: "createProjectFile",
        }),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(response.resolution).toBe("known-but-not-usable");
      expect(response.usageDocumentation).toBeNull();
      expect(response.escalationIdentifier).not.toBeNull();
      expect(streamed.join("\n")).toContain("[工具能力升级]");
      expect(response.isAuthorizationGranted).toBe(false);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("缺失工具 ⇒ escalated-missing-tool；陈旧 revision ⇒ stale-request；非法请求 ⇒ rejected", async () => {
    const { runtime } = await createHarness();
    try {
      const missing = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest({
          requestIdentifier: "req-3",
          requestKind: "missing-capability",
          toolIdentifier: "noSuchTool",
          blockingReason: "no-known-match",
        }),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(missing.resolution).toBe("escalated-missing-tool");

      const stale = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest({ requestIdentifier: "req-4", knownToolGroupRevision: 0 }),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(stale.resolution).toBe("stale-request");

      const invalid = await runtime.controller.answerToolHelpRequest({
        request: { controlEventType: "WRONG" },
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(invalid.resolution).toBe("rejected");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("同一 request 幂等：重复调用返回同一结果", async () => {
    const { runtime } = await createHarness();
    try {
      const first = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest({ requestIdentifier: "req-idem" }),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      const second = await runtime.controller.answerToolHelpRequest({
        request: usageHelpRequest({ requestIdentifier: "req-idem" }),
        requesterAgentInstanceId: "worker:mission-help:T-001",
        defaultSuperiorAgentInstanceId: "secondary-help",
        missionId: "mission-help",
      });
      expect(second).toEqual(first);
      expect(second.resolution).toBe("usage-provided");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
