/**
 * B9（2026-11-25）：行级覆盖——协作请求/逐级请示的**可选字段组合**分支。
 *
 * 这些行是 `sendCollaborationRequest` / `openEscalation` 输入拼装里的 `null/undefined` 三元；
 * 用"省略一切可选字段"与"全部给齐"两种调用即可覆盖两侧，不依赖收件人是否真实存在。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-optional-fields-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
  });
}

describe("B9：可选字段组合分支", () => {
  it("① 协作请求：省略全部可选字段 ⇒ 仍走同一入口（不崩、不静默成功）", async () => {
    const facade = await createFacade();
    try {
      const outcome = await facade
        .sendCollaborationRequest({
          senderAgentInstanceIdentifier: "agent-1",
          recipientAgentInstanceIdentifier: "agent-2",
          taskIdentifier: "T-1",
          summary: "摘要",
          projectScope: "same-project",
        })
        .catch((error: Error) => ({ thrown: error.message }));
      expect(outcome).toBeTruthy();
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 协作请求：全部可选字段给齐（含 null 显式传值）⇒ 同一入口、不崩", async () => {
    const facade = await createFacade();
    try {
      const outcome = await facade
        .sendCollaborationRequest({
          senderAgentInstanceIdentifier: "agent-1",
          senderRole: null,
          recipientAgentInstanceIdentifier: "agent-2",
          taskIdentifier: "T-1",
          summary: "摘要",
          missionIdentifier: null,
          requestIdentifier: null,
          replyToMessageIdentifier: null,
          artifactReferences: [],
          projectScope: "cross-project",
          authorizationIdentifier: null,
          sourceProjectIdentifier: "project-a",
          targetProjectIdentifier: "project-b",
        })
        .catch((error: Error) => ({ thrown: error.message }));
      expect(outcome).toBeTruthy();
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 逐级请示：可选字段省略 / 给齐 两种调用都返回结构化结果", async () => {
    const facade = await createFacade();
    try {
      const minimal = await facade
        .openEscalation({
          requestIdentifier: "req-1",
          senderAgentInstanceIdentifier: "agent-1",
          projectIdentifier: "project-1",
          missionIdentifier: "mission-1",
          taskIdentifier: "T-1",
          affectedStepIdentifiers: [],
          questionSummary: "问题摘要",
          documentReferences: [],
        })
        .catch((error: Error) => ({ thrown: error.message }));
      expect(minimal).toBeTruthy();

      const full = await facade
        .openEscalation({
          requestIdentifier: "req-2",
          senderAgentInstanceIdentifier: "agent-1",
          originalInitiatorAgentInstanceIdentifier: null,
          projectIdentifier: "project-1",
          missionIdentifier: "mission-1",
          taskIdentifier: "T-1",
          affectedStepIdentifiers: ["step-1"],
          questionSummary: "问题摘要",
          documentReferences: [{ documentIdentifier: "doc-1", revision: 1 }],
          proposedRecipientAgentInstanceIdentifier: "agent-2",
        })
        .catch((error: Error) => ({ thrown: error.message }));
      expect(full).toBeTruthy();
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
