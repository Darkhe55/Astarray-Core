/**
 * COORD-01-03（卡 §3）：**稳定重试身份**。
 *
 * 反例优先：
 * - **相同文本、无请求 ID ⇒ 两条独立消息**（禁止按文本猜测"这就是重试"）；
 * - 同来源同请求 ID 同内容 ⇒ 复用同一消息 ID 与恢复令牌；
 * - 同来源同请求 ID **异内容** ⇒ 冲突（拒绝覆盖，交回既有记录）；
 * - 恢复令牌可重放；重启后仍可复用。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoordinationSubmissionIdentityStore } from "../../../packages/core/src/orchestration/coordination-submission-identity.js";

let stateDirectory: string;
const partitionKey = "project:project-alpha|scheduler:scheduler-1";
const identicalText = "请把只读视图补齐";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-identity-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore() {
  return new CoordinationSubmissionIdentityStore({ stateDirectory });
}

describe("稳定重试身份", () => {
  it("① 相同文本、无请求 ID ⇒ 两条**独立**消息（不按文本去重）", async () => {
    const store = buildStore();
    const first = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      contentFingerprint: identicalText,
    });
    const second = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      contentFingerprint: identicalText,
    });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    if (first.outcome !== "created" || second.outcome !== "created") return;
    expect(first.record.messageIdentifier).not.toBe(second.record.messageIdentifier);
  });

  it("② 同请求 ID 同内容 ⇒ 复用同一身份与恢复令牌", async () => {
    const store = buildStore();
    const first = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      requestIdentifier: "request-1",
      contentFingerprint: identicalText,
    });
    const replay = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      requestIdentifier: "request-1",
      contentFingerprint: identicalText,
    });
    expect(replay.outcome).toBe("reused");
    if (first.outcome !== "created" || replay.outcome !== "reused") return;
    expect(replay.record.messageIdentifier).toBe(first.record.messageIdentifier);
    expect(replay.record.recoveryToken).toBe(first.record.recoveryToken);
  });

  it("③ 同请求 ID **异内容** ⇒ 冲突，不覆盖既有身份", async () => {
    const store = buildStore();
    const first = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      requestIdentifier: "request-1",
      contentFingerprint: identicalText,
    });
    const conflict = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      requestIdentifier: "request-1",
      contentFingerprint: "改成了另一个任务",
    });
    expect(conflict.outcome).toBe("conflict");
    if (first.outcome !== "created" || conflict.outcome !== "conflict") return;
    expect(conflict.existingRecord.messageIdentifier).toBe(first.record.messageIdentifier);
  });

  it("④ 恢复令牌可重放；未知令牌返回 null", async () => {
    const store = buildStore();
    const created = await store.submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      contentFingerprint: identicalText,
    });
    if (created.outcome !== "created") throw new Error("期望 created");
    const resumed = await store.resumeByRecoveryToken({
      partitionKey,
      recoveryToken: created.record.recoveryToken,
    });
    expect(resumed?.messageIdentifier).toBe(created.record.messageIdentifier);
    expect(
      await store.resumeByRecoveryToken({ partitionKey, recoveryToken: "recovery:missing" }),
    ).toBeNull();
  });

  it("⑤ 重启后按请求 ID 仍复用（身份持久化）", async () => {
    const first = await buildStore().submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      requestIdentifier: "request-9",
      contentFingerprint: identicalText,
    });
    const restarted = await buildStore().submit({
      partitionKey,
      sourceIdentifier: "user:alice",
      requestIdentifier: "request-9",
      contentFingerprint: identicalText,
    });
    expect(restarted.outcome).toBe("reused");
    if (first.outcome !== "created" || restarted.outcome !== "reused") return;
    expect(restarted.record.messageIdentifier).toBe(first.record.messageIdentifier);
  });
});
