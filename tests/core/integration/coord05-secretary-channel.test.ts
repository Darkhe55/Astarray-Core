/**
 * COORD-05 05-04（2026-11-23）：秘书通道端口反例。
 *
 * 覆盖：未激活拒绝、激活后投递并取真实回执、投递失败保持待呈交、空回执拒绝、已呈交幂等。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DecisionSubmissionStore,
  submitDecision,
} from "../../../packages/core/src/orchestration/decision-submission.js";
import { createSecretaryDecisionChannel } from "../../../packages/core/src/orchestration/secretary-decision-channel.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-secretary-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  } as never;
}

function deps(options: {
  activated: boolean;
  dispatcher?: { dispatch: ReturnType<typeof vi.fn> };
}) {
  const dispatcher =
    options.dispatcher ??
    { dispatch: vi.fn(async () => ({ receiptIdentifier: "secretary-receipt-1" })) };
  return {
    store: new DecisionSubmissionStore({ baseDirectory }),
    isSecretaryActivated: async () => options.activated,
    secretaryChannel: createSecretaryDecisionChannel({
      isActivated: async () => options.activated,
      dispatcher: dispatcher as never,
    }),
    userChannel: {
      submit: async () => {
        throw new Error("用户通道不应被调用");
      },
    },
    dispatcher,
  };
}

describe("COORD-05：秘书通道端口", () => {
  it("① 未激活 ⇒ 拒绝呈交，记录保持待呈交", async () => {
    const d = deps({ activated: false });
    const outcome = await submitDecision(d, input());
    expect(outcome).toMatchObject({ kind: "refused", code: "channel-unavailable" });
    expect((await d.store.list())[0]?.state).toBe("pending-record");
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("② 已激活 ⇒ 投递一次并带回真实回执", async () => {
    const d = deps({ activated: true });
    const outcome = await submitDecision(d, input());
    expect(outcome).toMatchObject({
      kind: "submitted",
      channel: "secretary",
      receiptIdentifier: "secretary-receipt-1",
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(d.dispatcher.dispatch.mock.calls[0]?.[0]).toMatchObject({
      submissionIdentifier: "escalation-1",
      projectIdentifier: "p1",
      decisionId: "decision-1",
      ownerAgentInstanceId: "tertiary-1",
      taskIdentifier: "T-1",
    });
  });

  it("③ 投递失败 ⇒ channel-unavailable，不留假回执", async () => {
    const failing = {
      dispatch: vi.fn(async () => {
        throw new Error("投递网络失败");
      }),
    };
    const d = deps({ activated: true, dispatcher: failing });
    const outcome = await submitDecision(d, input());
    expect(outcome).toMatchObject({ kind: "refused", code: "channel-unavailable" });
    expect((await d.store.list())[0]?.state).toBe("pending-record");
  });

  it("④ 空回执 ⇒ 拒绝伪造成功", async () => {
    const empty = { dispatch: vi.fn(async () => ({ receiptIdentifier: "  " })) };
    const d = deps({ activated: true, dispatcher: empty });
    const outcome = await submitDecision(d, input());
    expect(outcome).toMatchObject({ kind: "refused", code: "channel-unavailable" });
  });

  it("⑤ 已呈交后重复呈交 ⇒ duplicate，不再投递", async () => {
    const d = deps({ activated: true });
    await submitDecision(d, input());
    const second = await submitDecision(d, input());
    expect(second.kind).toBe("duplicate");
    expect(d.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("⑥ 直接调用通道且未激活 ⇒ 抛错（防御纵深，不靠 submitDecision 前置）", async () => {
    const channel = createSecretaryDecisionChannel({
      isActivated: async () => false,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    await expect(
      channel.submit({
        submissionIdentifier: "escalation-1",
        projectIdentifier: "p1",
        decisionId: "decision-1",
        ownerAgentInstanceId: "tertiary-1",
        taskIdentifier: "T-1",
        summary: "x",
        recommendedReason: null,
        affectedStepIdentifiers: [],
        candidates: [],
      }),
    ).rejects.toThrow("秘书未激活");
  });
});