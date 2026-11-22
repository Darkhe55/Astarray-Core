/**
 * COORD-05（2026-11-22）：公开门面的请示入口。
 *
 * 证明产品路径可用：注册真实管理树 → 门面 openEscalation 解析直属上级 → 处理人结案 →
 * 查询状态与幂等重开；未登记发送者被拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentCreationRegistry,
  AstarrayApplicationFacade,
} from "../../../packages/core/src/public-sdk.js";

let temporaryDirectory: string;
let stateDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-sdk-"));
  stateDirectory = path.join(temporaryDirectory, ".astarray");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("COORD-05：门面请示入口", () => {
  it("① 打开 ⇒ 直属上级；结案 ⇒ resolved；重复打开幂等", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const registry = new AgentCreationRegistry({ stateDirectory });
      await registry.registerCreatedAgent({ agentInstanceId: "m1", createdByAgentInstanceId: null });
      await registry.registerCreatedAgent({ agentInstanceId: "s1", createdByAgentInstanceId: "m1" });
      await registry.registerCreatedAgent({ agentInstanceId: "w1", createdByAgentInstanceId: "s1" });

      const opened = await application.openEscalation({
        requestIdentifier: "escalation-1",
        senderAgentInstanceIdentifier: "w1",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: ["step-export"],
        questionSummary: "导出方式需要确认",
        documentReferences: [{ documentIdentifier: "docs/spec.md", revision: 2 }],
      });
      expect(opened).toMatchObject({
        kind: "opened",
        target: { kind: "agent", agentInstanceId: "s1" },
      });
      if (opened.kind !== "opened") return;

      const resolved = await application.handleEscalation({
        requestIdentifier: "escalation-1",
        expectedVersion: opened.record.version,
        handlerAgentInstanceId: "s1",
        disposition: "resolved",
        reason: "本层有材料，直接拍板",
        referencedDocumentIdentifiers: ["docs/spec.md"],
      });
      expect(resolved.kind).toBe("resolved");
      if (resolved.kind !== "resolved") return;
      expect(resolved.record.state).toBe("resolved-by-agent");

      const queried = await application.queryEscalation({ requestIdentifier: "escalation-1" });
      expect(queried?.state).toBe("resolved-by-agent");

      const reopened = await application.openEscalation({
        requestIdentifier: "escalation-1",
        senderAgentInstanceIdentifier: "w1",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: ["step-export"],
        questionSummary: "导出方式需要确认",
        documentReferences: [{ documentIdentifier: "docs/spec.md", revision: 2 }],
      });
      expect(reopened.kind).toBe("existing");
    } finally {
      await application.shutdown();
    }
  });

  it("② 未登记发送者 ⇒ 拒绝（不建记录）", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const opened = await application.openEscalation({
        requestIdentifier: "escalation-2",
        senderAgentInstanceIdentifier: "ghost",
        projectIdentifier: "p1",
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        affectedStepIdentifiers: [],
        questionSummary: "x",
        documentReferences: [],
      });
      expect(opened).toMatchObject({ kind: "refused", code: "unknown-sender" });
      expect(await application.queryEscalation({ requestIdentifier: "escalation-2" })).toBeNull();
    } finally {
      await application.shutdown();
    }
  });
});
