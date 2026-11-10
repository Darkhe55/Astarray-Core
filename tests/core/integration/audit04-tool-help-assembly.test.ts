/**
 * AUDIT-REPAIR-01 检查点 04（2026-11-10）：**装配级**工具说明回访。
 *
 * 三条决定性事实（读 `main-controller.ts:988-1012` 得到）：
 *  1. 陈旧检查用 `mission.taskChain.revision`（不是固定常量）；
 *  2. 分配集合 = 任务 `toolNames` ∩ 注册表；
 *  3. **公开用法登记缺失 ⇒ fail-closed ⇒ 该工具被视为"未分配"**，
 *     所以必须由宿主注入 `toolDocumentationRegistry`（`application-runtime.ts:853`）。
 *
 * 本文件正是按这三点注入最小登记表，再从装配入口验证两条路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-audit04-help-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

/** 宿主必须显式登记的 5 项（描述符里没有权威来源）。 */
const readFileDocumentationEntry = {
  examples: ['{"filePath":"docs/readme.md"}'],
  failureCodes: ["permission-denied", "file-not-found"],
  returnSchemaJson: '{"type":"string"}',
  requiredCapabilities: ["project.read"],
  limitations: ["只读：不接受写入意图"],
};

function buildHelpRequest(toolIdentifier: string, knownToolGroupRevision: number) {
  return {
    controlEventType: "ASTARRAY_TOOL_HELP_REQUEST_V1",
    requestIdentifier: "req-" + toolIdentifier,
    taskExecutionIdentifier: "exec-1",
    requestKind: "usage-help",
    toolIdentifier,
    capabilityIntent: "需要该工具的用法说明",
    blockingReason: "forgot-usage",
    knownToolGroupRevision,
  };
}

describe("AUDIT-REPAIR-01-04 装配级：工具说明回访", () => {
  it("已分配 ⇒ 返回用法且不是授权；未知工具 ⇒ 向上级反馈", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 2,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      /** 关键：宿主注入公开用法登记表，否则一切工具都被判"未分配"（fail-closed）。 */
      toolDocumentationRegistry: { readFile: readFileDocumentationEntry },
      workerRuntimeFactory: () => ({
        async *run() {
          yield {
            kind: "runFinished",
            agentId: "worker-1",
            reason: "success",
            detail: "完成",
          };
        },
      }),
    });
    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("工具说明回访", {
        projectIdentifier: "project-alpha",
      });
      const deadline = Date.now() + 30_000;
      let chain = await runtime.taskStore.readTaskChain(missionIdentifier);
      while (
        (chain === null || !chain.tasks.some((task) => task.toolNames.includes("readFile"))) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        chain = await runtime.taskStore.readTaskChain(missionIdentifier);
      }
      expect(chain, "任务链未就绪").not.toBeNull();
      if (chain === null) throw new Error("unreachable");
      const task = chain.tasks.find((candidate) => candidate.toolNames.includes("readFile"));
      expect(task, "任务链没有声明 readFile 的任务").toBeDefined();
      if (task === undefined) throw new Error("unreachable");

      const assignedResponse = await runtime.controller.answerToolHelpRequest({
        request: buildHelpRequest("readFile", chain.revision),
        requesterAgentInstanceId: task.assignedAgentId ?? "worker-1",
        defaultSuperiorAgentInstanceId: "secondary-1",
        missionId: missionIdentifier,
      });
      expect(
        assignedResponse.resolution,
        `resolution=${assignedResponse.resolution}`,
      ).toBe("usage-provided");
      expect(assignedResponse.usageDocumentation?.toolIdentifier).toBe("readFile");
      /** 给用法 ≠ 授权。 */
      expect(assignedResponse.isAuthorizationGranted).toBe(false);

      const unknownResponse = await runtime.controller.answerToolHelpRequest({
        request: buildHelpRequest("definitelyNotATool", chain.revision),
        requesterAgentInstanceId: task.assignedAgentId ?? "worker-1",
        defaultSuperiorAgentInstanceId: "secondary-1",
        missionId: missionIdentifier,
      });
      /**
       * 未知工具 + `usage-help` 语义 ⇒ known-but-not-usable（不泄露 schema、不当作 missing-capability）。
       * `escalated-missing-tool` 属 `missing-capability` 请求，另有用例覆盖。
       */
      expect(unknownResponse.resolution).toBe("known-but-not-usable");
      expect(unknownResponse.usageDocumentation).toBeNull();
      expect(unknownResponse.escalationIdentifier).not.toBeNull();
      /** `missing-capability` 请求：能力不存在 ⇒ 向上级反馈（missing-tool）。 */
      const missingResponse = await runtime.controller.answerToolHelpRequest({
        request: {
          controlEventType: "ASTARRAY_TOOL_HELP_REQUEST_V1",
          requestIdentifier: "req-missing",
          taskExecutionIdentifier: "exec-1",
          requestKind: "missing-capability",
          toolIdentifier: null,
          capabilityIntent: "需要访问远端仓库",
          blockingReason: "no-known-match",
          knownToolGroupRevision: chain.revision,
        },
        requesterAgentInstanceId: task.assignedAgentId ?? "worker-1",
        defaultSuperiorAgentInstanceId: "secondary-1",
        missionId: missionIdentifier,
      });
      expect(missingResponse.resolution).toBe("escalated-missing-tool");
      expect(missingResponse.escalationIdentifier).not.toBeNull();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);
});
