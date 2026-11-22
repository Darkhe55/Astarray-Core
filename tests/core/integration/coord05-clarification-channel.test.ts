/**
 * COORD-05 05-04（2026-11-22）：直接用户通道 = 用户待决记录（复用 05-03 存储）。
 *
 * 覆盖：登记一次、幂等重试不重复、重启后不重复、缺提交方/任务时拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserClarificationStore } from "../../../packages/core/src/orchestration/user-clarification.js";
import {
  DecisionSubmissionStore,
  submitDecision,
} from "../../../packages/core/src/orchestration/decision-submission.js";
import { createClarificationUserChannel } from "../../../packages/core/src/orchestration/clarification-decision-channel.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-channel-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    submissionIdentifier: "escalation-1",
    projectIdentifier: "p1",
    decisionId: "decision-1",
    ownerAgentInstanceId: "m1",
    taskIdentifier: "T-1",
    summary: "导出方式需要拍板",
    recommendedReason: "与现有约定一致",
    affectedStepIdentifiers: ["step-export"],
    candidates: [{ candidateIdentifier: "c1", label: "方案 A", value: "a" }],
    nowIso: "2026-11-22T00:00:00.000Z",
    ...overrides,
  } as never;
}

function service(options: {
  store?: DecisionSubmissionStore;
  clarification?: UserClarificationStore;
}) {
  return {
    store: options.store ?? new DecisionSubmissionStore({ baseDirectory }),
    isSecretaryActivated: async () => false,
    secretaryChannel: {
      submit: async () => {
        throw new Error("秘书未启用");
      },
    },
    userChannel: createClarificationUserChannel({
      store: options.clarification ?? new UserClarificationStore({ baseDirectory }),
      nowIso: () => "2026-11-22T00:00:00.000Z",
    }),
  };
}

describe("COORD-05：直接用户通道", () => {
  it("① 呈交 ⇒ 一条待决记录，回执即澄清记录标识", async () => {
    const deps = service({});
    const outcome = await submitDecision(deps, input());
    expect(outcome.kind).toBe("submitted");
    if (outcome.kind !== "submitted") return;
    expect(outcome.channel).toBe("direct-user");
    const clarifications = await new UserClarificationStore({ baseDirectory }).listPending("p1");
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]?.clarificationIdentifier).toBe(outcome.receiptIdentifier);
    expect(clarifications[0]?.sourceRequestIdentifier).toBe("escalation-1");
    expect(clarifications[0]?.impactSummary).toBeUndefined();
    expect(clarifications[0]?.recommendedReason).toBe("与现有约定一致");
    expect(clarifications[0]?.blockedStepIdentifiers).toEqual(["step-export"]);
  });

  it("② 重复呈交 ⇒ duplicate，不产生第二条待决记录", async () => {
    const deps = service({});
    await submitDecision(deps, input());
    const second = await submitDecision(deps, input());
    expect(second.kind).toBe("duplicate");
    expect(await new UserClarificationStore({ baseDirectory }).listPending("p1")).toHaveLength(1);
  });

  it("③ 重启（新实例）后重复呈交 ⇒ 仍只有一条", async () => {
    const firstDeps = service({});
    await submitDecision(firstDeps, input());
    const restartDeps = service({});
    const outcome = await submitDecision(restartDeps, input());
    expect(outcome.kind).toBe("duplicate");
    expect(await new UserClarificationStore({ baseDirectory }).listPending("p1")).toHaveLength(1);
  });

  it("④ 缺提交方/任务 ⇒ 通道拒绝，记录保持待呈交", async () => {
    const deps = service({});
    const missingOwner = await submitDecision(deps, input({ ownerAgentInstanceId: undefined }));
    expect(missingOwner).toMatchObject({ kind: "refused", code: "channel-unavailable" });
    expect((await deps.store.list())[0]?.state).toBe("pending-record");
  });
});
