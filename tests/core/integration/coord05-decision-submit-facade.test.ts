/**
 * COORD-05 05-04（2026-11-23）：门面 `submitDecisionSummary` 入口。
 *
 * 覆盖：无秘书 ⇒ 直接用户通道登记待决记录；有秘书 ⇒ 秘书回执；秘书未激活 ⇒ 拒绝且保持待呈交。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { UserClarificationStore } from "../../../packages/core/src/orchestration/user-clarification.js";
import { DecisionSubmissionStore } from "../../../packages/core/src/orchestration/decision-submission.js";

let temporaryDirectory: string;
let stateDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-submit-"));
  stateDirectory = path.join(temporaryDirectory, ".astarray");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function application(): Promise<AstarrayApplicationFacade> {
  const app = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
    statusPollIntervalMilliseconds: 10,
  });
  app.createSession({ sessionId: "session-1", mode: "assist" });
  return app;
}

const baseSubmission = {
  submissionIdentifier: "escalation-1",
  projectIdentifier: "p1",
  decisionId: "decision-1",
  ownerAgentInstanceId: "tertiary-1",
  taskIdentifier: "T-1",
  summary: "是否允许安装依赖",
  recommendedReason: "范围内",
  affectedStepIdentifiers: ["step-export"],
  candidates: [{ candidateIdentifier: "c1", label: "允许", value: "yes" }],
  nowIso: "2026-11-23T00:00:00.000Z",
} as const;

describe("COORD-05：门面决定呈交", () => {
  it("① 无秘书 ⇒ 直接用户通道登记一条待决记录", async () => {
    const app = await application();
    try {
      const outcome = await app.submitDecisionSummary(baseSubmission);
      expect(outcome).toMatchObject({ kind: "submitted", channel: "direct-user" });
      const pending = await new UserClarificationStore({ baseDirectory: stateDirectory }).listPending("p1");
      expect(pending).toHaveLength(1);
    } finally {
      await app.shutdown();
    }
  });

  it("② 有秘书（激活）⇒ 秘书回执", async () => {
    const app = await application();
    try {
      const dispatch = vi.fn(async () => ({ receiptIdentifier: "secretary-receipt-1" }));
      const outcome = await app.submitDecisionSummary({
        ...baseSubmission,
        secretary: { isActivated: async () => true, dispatcher: { dispatch } },
      });
      expect(outcome).toMatchObject({
        kind: "submitted",
        channel: "secretary",
        receiptIdentifier: "secretary-receipt-1",
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await app.shutdown();
    }
  });

  it("③ 秘书未激活 ⇒ 回退直接用户通道（登记待决记录）", async () => {
    const app = await application();
    try {
      const outcome = await app.submitDecisionSummary({
        ...baseSubmission,
        secretary: {
          isActivated: async () => false,
          dispatcher: { dispatch: vi.fn() },
        },
      });
      expect(outcome).toMatchObject({ kind: "submitted", channel: "direct-user" });
      const pending = await new UserClarificationStore({ baseDirectory: stateDirectory }).listPending("p1");
      expect(pending).toHaveLength(1);
    } finally {
      await app.shutdown();
    }
  });

  it("④ 秘书激活但投递失败 ⇒ 拒绝且保持待呈交", async () => {
    const app = await application();
    try {
      const outcome = await app.submitDecisionSummary({
        ...baseSubmission,
        secretary: {
          isActivated: async () => true,
          dispatcher: {
            dispatch: async () => {
              throw new Error("投递失败");
            },
          },
        },
      });
      expect(outcome).toMatchObject({ kind: "refused", code: "channel-unavailable" });
      const records = await new DecisionSubmissionStore({ baseDirectory: stateDirectory }).list();
      expect(records[0]?.state).toBe("pending-record");
    } finally {
      await app.shutdown();
    }
  });
});
