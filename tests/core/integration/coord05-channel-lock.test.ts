/**
 * D1（2026-11-23 产品裁决）：秘书通道语义收紧。
 *
 * - 首次尝试锁定通道并持久化，重试沿用同一通道与同一待决 ID（避免双发）；
 * - 权威激活状态读取失败 ⇒ 保持待呈交，不切换到用户通道；
 * - 已知未激活 ⇒ 首次即走直接用户通道。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DecisionSubmissionStore,
  submitDecision,
} from "../../../packages/core/src/orchestration/decision-submission.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-d1-channel-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const input = {
  submissionIdentifier: "escalation-1",
  projectIdentifier: "p1",
  decisionId: "decision-1",
  ownerAgentInstanceId: "tertiary-1",
  taskIdentifier: "T-1",
  summary: "是否允许安装",
  recommendedReason: null,
  affectedStepIdentifiers: [],
  candidates: [],
  nowIso: "2026-11-23T00:00:00.000Z",
} as const;

function deps(options: {
  activation?: () => Promise<boolean>;
  secretarySubmit?: () => Promise<{ receiptIdentifier: string }>;
  userSubmit?: () => Promise<{ receiptIdentifier: string }>;
}) {
  const store = new DecisionSubmissionStore({ baseDirectory });
  return {
    store,
    isSecretaryActivated: options.activation ?? (async () => false),
    secretaryChannel: {
      submit: async () => (options.secretarySubmit ?? (async () => ({ receiptIdentifier: "sec-1" })))(),
    },
    userChannel: {
      submit: async () => (options.userSubmit ?? (async () => ({ receiptIdentifier: "user-1" })))(),
    },
  };
}

describe("D1：秘书通道语义", () => {
  it("① 权威状态读取失败 ⇒ 保持待呈交，且不锁定通道", async () => {
    const d = deps({
      activation: async () => {
        throw new Error("状态存储不可读");
      },
    });
    const outcome = await submitDecision(d, input);
    expect(outcome).toMatchObject({ kind: "refused", code: "channel-unavailable" });
    const record = (await d.store.list())[0];
    expect(record?.state).toBe("pending-record");
    expect(record?.selectedChannel ?? null).toBeNull();
  });

  it("② 首次未激活 ⇒ 锁定直接用户通道；之后激活也不改通道", async () => {
    let activated = false;
    const d = deps({ activation: async () => activated });
    const first = await submitDecision(d, input);
    expect(first).toMatchObject({ kind: "submitted", channel: "direct-user" });

    activated = true;
    const second = await submitDecision(d, input);
    expect(second.kind).toBe("duplicate");
  });

  it("③ 秘书投递失败 ⇒ 保留待呈交且锁定秘书通道；重试不切换到用户通道", async () => {
    const secretarySubmit = vi.fn(async () => {
      throw new Error("投递失败");
    });
    const userSubmit = vi.fn(async () => ({ receiptIdentifier: "user-1" }));
    let activated = true;
    const d = deps({
      activation: async () => activated,
      secretarySubmit,
      userSubmit,
    });
    const first = await submitDecision(d, input);
    expect(first).toMatchObject({ kind: "refused", code: "channel-unavailable" });
    expect((await d.store.list())[0]?.selectedChannel).toBe("secretary");

    /** 即使此后秘书显示未激活，重试仍用同一通道（已锁定），绝不双发给用户。 */
    activated = false;
    const second = await submitDecision(d, input);
    expect(second).toMatchObject({ kind: "refused", code: "channel-unavailable" });
    expect(userSubmit).not.toHaveBeenCalled();
    expect(secretarySubmit).toHaveBeenCalledTimes(2);
  });

  it("④ 锁定后重试成功 ⇒ 一次呈交，通道为秘书", async () => {
    let attempt = 0;
    const d = deps({
      activation: async () => true,
      secretarySubmit: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("临时失败");
        return { receiptIdentifier: "sec-2" };
      },
    });
    expect((await submitDecision(d, input)).kind).toBe("refused");
    const retried = await submitDecision(d, input);
    expect(retried).toMatchObject({
      kind: "submitted",
      channel: "secretary",
      receiptIdentifier: "sec-2",
    });
  });
});
