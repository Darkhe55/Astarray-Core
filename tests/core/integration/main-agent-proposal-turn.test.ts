/**
 * ALIGN-01-03（2026-11-03）：主 Agent 回合 → 自动提交（进程内 ScriptedRuntime）。
 *
 * 目的：验证回合路径确实把模型提案交给本地提交面，且不再因"模型猜不到用户引用"被拒。
 * 目标次级不存在等本地拒绝允许出现，但不得是"引用不一致"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-proposal-turn-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const proposal = {
  targetSecondaryAgentInstanceIdentifier: "scheduler:mission-1",
  sequenceIdentifier: "sequence-1",
  expectedRevision: 0,
  title: "补文档",
  userTaskReference: "model-guess-reference",
  predecessorTaskIdentifiers: [],
  successorTaskIdentifiers: [],
  priorityTier: 1,
  requiredArtifactIdentifiers: [],
  acceptanceCriteria: "完成",
};

describe("主 Agent 回合自动提交", () => {
  it("回合把提案交给本地提交面，且不再报引用不一致", async () => {
    const streamed: string[] = [];
    const runtime = await createApplicationRuntime({
      mode: "ponder",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      isMainAgentProposalAutoSubmitEnabled: true,
      mainRuntimeFactory: () =>
        new ScriptedRuntime([
          { type: "text", text: JSON.stringify(proposal) },
          { type: "finish", reason: "success", detail: "ok" },
        ]),
      streamOutput: (_missionId: string | null, text: string) => {
        streamed.push(text);
      },
    });
    try {
      await runtime.controller.handleUserMessage("请补充一个文档任务");
      const joined = streamed.join("");
      /**
       * 目标次级不存在时本地提交面会拒绝（"无权管理序列"），这是预期的本地校验；
       * 关键断言：回合确实进入提交路径，且不再因用户引用不可知而被拒。
       */
      expect(joined).toContain("[主 Agent 提案未提交]");
      expect(joined).toContain("无权管理序列");
      expect(joined).not.toContain("引用不一致");
      expect(joined).not.toContain("必须引用一次用户原始任务");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
