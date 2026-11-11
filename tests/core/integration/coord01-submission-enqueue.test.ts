/**
 * COORD-01-03 §3：**稳定身份 ⇒ 重投不重复入队**。
 *
 * 这条把"身份原语"和"实际入队"连起来验证：同一请求 ID 两次提交得到同一 messageIdentifier，
 * 用它当 `idempotencyKey` 入队 ⇒ journal 只有一条待处理消息（重试不再产生第二条）。
 *
 * 反例同时锁住：**不同请求 ID 但文本相同** ⇒ 两条消息（不按文本去重）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationSubmissionIdentityStore } from "../../../packages/core/src/orchestration/coordination-submission-identity.js";

let stateDirectory: string;
const partitionKey = "project:project-alpha|scheduler:scheduler-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-identity-journal-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildHarness() {
  const journal = new MailboxJournal(path.join(stateDirectory, "journal"));
  const identityStore = new CoordinationSubmissionIdentityStore({
    stateDirectory: path.join(stateDirectory, "identity"),
  });
  return { journal, identityStore };
}

async function submitAndEnqueue(
  harness: ReturnType<typeof buildHarness>,
  requestIdentifier: string,
  contentFingerprint: string,
) {
  const outcome = await harness.identityStore.submit({
    partitionKey,
    sourceIdentifier: "user:alice",
    requestIdentifier,
    contentFingerprint,
  });
  if (outcome.outcome !== "created" && outcome.outcome !== "reused") {
    throw new Error(`期望 created/reused，实际 ${outcome.outcome}`);
  }
  await harness.journal.enqueue({
    protocolVersion: 1,
    messageId: outcome.record.messageIdentifier,
    source: { sourceType: "user", sourceIdentifier: "user:alice" },
    recipientId: "scheduler:mission-1",
    priority: "instruction",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: outcome.record.messageIdentifier,
    payload: { kind: "instruction", instructionText: contentFingerprint },
  } as never);
  return outcome.record.messageIdentifier;
}

describe("稳定身份与入队去重", () => {
  it("① 同一请求 ID 重投两次 ⇒ journal 只有一条", async () => {
    const harness = buildHarness();
    const firstMessageIdentifier = await submitAndEnqueue(harness, "request-1", "请把只读视图补齐");
    const secondMessageIdentifier = await submitAndEnqueue(harness, "request-1", "请把只读视图补齐");
    expect(secondMessageIdentifier).toBe(firstMessageIdentifier);
    expect(await harness.journal.countPending("scheduler:mission-1")).toBe(1);
  });

  it("② 不同请求 ID 但文本相同 ⇒ 两条消息（不按文本去重）", async () => {
    const harness = buildHarness();
    await submitAndEnqueue(harness, "request-1", "请把只读视图补齐");
    await submitAndEnqueue(harness, "request-2", "请把只读视图补齐");
    expect(await harness.journal.countPending("scheduler:mission-1")).toBe(2);
  });
});
