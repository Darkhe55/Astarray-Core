/**
 * COORD-05 05-04（2026-11-22）：呈交与答复。
 *
 * 覆盖：先落盘再发送（发送失败保持待呈交）、秘书/用户通道选择、重复呈交幂等、
 * 重启恢复与通道切换（仅无回执时）、答复的项目匹配与幂等。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DecisionSubmissionStore,
  submitDecision,
  type DecisionChannelPort,
} from "../../../packages/core/src/orchestration/decision-submission.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-04-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    submissionIdentifier: "escalation-1",
    projectIdentifier: "p1",
    decisionId: "decision-1",
    summary: "导出方式需要拍板",
    recommendedReason: "与现有约定一致",
    affectedStepIdentifiers: ["step-export"],
    candidates: [
      { candidateIdentifier: "c1", label: "方案 A", value: "a" },
      { candidateIdentifier: "c2", label: "方案 B", value: "b" },
    ],
    nowIso: "2026-11-22T00:00:00.000Z",
    ...overrides,
  } as never;
}

function fakeChannel(
  calls: string[],
  options: { failTimes?: number } = {},
): DecisionChannelPort {
  let remainingFailures = options.failTimes ?? 0;
  return {
    submit: async (input) => {
      calls.push(input.submissionIdentifier);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("通道暂时不可用");
      }
      return { receiptIdentifier: "receipt-" + input.submissionIdentifier };
    },
  };
}

function makeService(options: {
  store?: DecisionSubmissionStore;
  secretaryActive: boolean;
  secretaryCalls: string[];
  userCalls: string[];
  failTimes?: number;
}) {
  return {
    store: options.store ?? new DecisionSubmissionStore({ baseDirectory }),
    isSecretaryActivated: async () => options.secretaryActive,
    secretaryChannel: fakeChannel(options.secretaryCalls, { failTimes: options.failTimes }),
    userChannel: fakeChannel(options.userCalls, { failTimes: options.failTimes }),
  };
}

describe("COORD-05 05-04：呈交与答复", () => {
  it("① 先持久化再发送：通道失败时记录保持 pending-record", async () => {
    const secretaryCalls: string[] = [];
    const userCalls: string[] = [];
    const deps = makeService({
      secretaryActive: true,
      secretaryCalls,
      userCalls,
      failTimes: 1,
    });
    const outcome = await submitDecision(deps, baseInput());
    expect(outcome).toMatchObject({ kind: "refused", code: "channel-unavailable" });

    const persisted = await deps.store.list();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.state).toBe("pending-record");
    expect(secretaryCalls).toHaveLength(1);
  });

  it("② 秘书激活 ⇒ 走秘书通道；回执与状态落盘", async () => {
    const secretaryCalls: string[] = [];
    const userCalls: string[] = [];
    const deps = makeService({ secretaryActive: true, secretaryCalls, userCalls });
    const outcome = await submitDecision(deps, baseInput());
    expect(outcome).toMatchObject({ kind: "submitted", channel: "secretary" });
    expect(secretaryCalls).toHaveLength(1);
    expect(userCalls).toHaveLength(0);

    const persisted = await deps.store.list();
    expect(persisted[0]?.state).toBe("submitted");
    expect(persisted[0]?.channel).toBe("secretary");
    expect(persisted[0]?.receiptIdentifier).toBe("receipt-escalation-1");
  });

  it("③ 秘书未激活 ⇒ 直接用户通道", async () => {
    const secretaryCalls: string[] = [];
    const userCalls: string[] = [];
    const deps = makeService({ secretaryActive: false, secretaryCalls, userCalls });
    const outcome = await submitDecision(deps, baseInput());
    expect(outcome).toMatchObject({ kind: "submitted", channel: "direct-user" });
    expect(userCalls).toHaveLength(1);
  });

  it("④ 重复呈交 ⇒ duplicate，不产生第二个逻辑问题", async () => {
    const secretaryCalls: string[] = [];
    const userCalls: string[] = [];
    const deps = makeService({ secretaryActive: false, secretaryCalls, userCalls });
    const first = await submitDecision(deps, baseInput());
    expect(first.kind).toBe("submitted");
    const second = await submitDecision(deps, baseInput());
    expect(second.kind).toBe("duplicate");
    expect(userCalls).toHaveLength(1);
  });

  it("⑤ D1：首次锁定用户通道，重启后秘书已激活仍不换通道（同一待决 ID 呈交一次）", async () => {
    const firstSecretary: string[] = [];
    const firstUser: string[] = [];
    const firstDeps = makeService({
      secretaryActive: false,
      secretaryCalls: firstSecretary,
      userCalls: firstUser,
      failTimes: 1,
    });
    expect((await submitDecision(firstDeps, baseInput())).kind).toBe("refused");

    /** 重启：新存储实例 + 秘书已激活；待呈交记录仍在。 */
    const secondSecretary: string[] = [];
    const secondUser: string[] = [];
    const secondDeps = makeService({
      secretaryActive: true,
      secretaryCalls: secondSecretary,
      userCalls: secondUser,
    });
    const outcome = await submitDecision(secondDeps, baseInput());
    /** 2026-11-23（D1）：首次已锁定用户通道 ⇒ 重启后即使秘书激活也不切换（避免双发）。 */
    expect(outcome).toMatchObject({ kind: "submitted", channel: "direct-user" });
    expect(secondUser).toHaveLength(1);
    expect(secondSecretary).toHaveLength(0);

    /** 已呈交后再呈交 ⇒ duplicate，不再发送。 */
    expect((await submitDecision(secondDeps, baseInput())).kind).toBe("duplicate");
    expect(secondUser).toHaveLength(1);
  });

  it("⑥ 答复：项目匹配才写回；重复答复幂等；未呈交不可答复", async () => {
    const deps = makeService({ secretaryActive: false, secretaryCalls: [], userCalls: [] });
    const pendingOnly = new DecisionSubmissionStore({ baseDirectory });
    await pendingOnly.upsertPending({
      submissionIdentifier: "escalation-2",
      projectIdentifier: "p1",
      decisionId: "decision-2",
      summary: "待呈交",
      recommendedReason: null,
      affectedStepIdentifiers: [],
      candidates: [],
      state: "pending-record",
      channel: null,
      receiptIdentifier: null,
      createdAtIso: "2026-11-22T00:00:00.000Z",
      submittedAtIso: null,
      answeredAtIso: null,
      answer: null,
    });
    const notSubmitted = await pendingOnly.markAnswered({
      submissionIdentifier: "escalation-2",
      projectIdentifier: "p1",
      answer: "a",
      answeredAtIso: "2026-11-22T00:00:01.000Z",
    });
    expect(notSubmitted).toMatchObject({ kind: "refused", code: "not-submitted" });

    await submitDecision(deps, baseInput());
    const mismatch = await deps.store.markAnswered({
      submissionIdentifier: "escalation-1",
      projectIdentifier: "p2",
      answer: "a",
      answeredAtIso: "2026-11-22T00:00:02.000Z",
    });
    expect(mismatch).toMatchObject({ kind: "refused", code: "project-mismatch" });

    const answered = await deps.store.markAnswered({
      submissionIdentifier: "escalation-1",
      projectIdentifier: "p1",
      answer: "a",
      answeredAtIso: "2026-11-22T00:00:03.000Z",
    });
    expect(answered.kind).toBe("answered");
    if (answered.kind !== "answered") return;
    expect(answered.record.state).toBe("answered");
    expect(answered.record.answer).toBe("a");

    const again = await deps.store.markAnswered({
      submissionIdentifier: "escalation-1",
      projectIdentifier: "p1",
      answer: "a",
      answeredAtIso: "2026-11-22T00:00:04.000Z",
    });
    expect(again.kind).toBe("answered");
    if (again.kind !== "answered") return;
    expect(again.record.answeredAtIso).toBe("2026-11-22T00:00:03.000Z");
  });

  it("⑦ 存储损坏 ⇒ 拒绝呈交（不覆盖）", async () => {
    await fs.mkdir(path.join(baseDirectory, "escalations"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "escalations", "submissions.json"),
      "{broken",
      "utf8",
    );
    const deps = makeService({ secretaryActive: false, secretaryCalls: [], userCalls: [] });
    const outcome = await submitDecision(deps, baseInput());
    expect(outcome).toMatchObject({ kind: "refused", code: "corrupted-store" });
  });
});
