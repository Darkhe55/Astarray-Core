/**
 * 2026-11-21（用户裁决 C）：死信的人工处置入口（store 层）。
 *
 * 纪律：只读清点不抛错；重放必须**原样**写回补送且不改内容；文件名防穿越；
 * 已存在同键补送文件时不重复写（`already-queued`）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FeedbackDeadLetterStore } from "../../../packages/core/src/feedback-process/dead-letter.js";
import { writeAtomicJson } from "../../../packages/core/src/infra/atomic-json.js";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";

let baseDirectory: string;
let store: FeedbackDeadLetterStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-dead-letter-"));
  store = new FeedbackDeadLetterStore({ baseDirectory });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function fileNameFor(idempotencyKey: string): string {
  return `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`;
}

function buildMessage(idempotencyKey: string): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: `3f1c8a52-6d47-4d0e-9a3b-2c5e7f8a1b64`,
    source: { sourceType: "agent", agentInstanceId: "agent-a1", agentRole: "secondary" },
    recipientId: "scheduler:mission-1",
    priority: "instruction",
    createdAtIso: "2026-11-21T00:00:00.000Z",
    idempotencyKey,
    payload: { kind: "instruction", instructionText: "请继续" },
  };
}

async function seedDeadLetter(idempotencyKey: string): Promise<string> {
  const fileName = fileNameFor(idempotencyKey);
  await writeAtomicJson(path.join(store.directoryPath, fileName), {
    schemaVersion: 1,
    rejectedAtIso: "2026-11-21T00:00:01.000Z",
    rejectionCode: "invalid-message",
    rejectionReason: "Invalid UUID",
    idempotencyKey,
    messageId: buildMessage(idempotencyKey).messageId,
    message: buildMessage(idempotencyKey),
  });
  return fileName;
}

describe("反馈死信存储", () => {
  it("① list 只读清点；损坏/非法文件名只计数、不抛错", async () => {
    const fileName = await seedDeadLetter("key-1");
    await writeAtomicJson(path.join(store.directoryPath, "not-a-hash.json"), { any: "thing" });
    await fs.writeFile(path.join(store.directoryPath, "broken.json"), "{ not json", "utf8");

    const outcome = await store.list();
    expect(outcome.entries.map((entry) => entry.fileName)).toContain(fileName);
    expect(outcome.invalidCount).toBeGreaterThanOrEqual(2);
    expect(outcome.entries[0]?.record.rejectionCode).toBe("invalid-message");
  });

  it("② requeue 原样写回补送并删除死信；内容逐字节一致", async () => {
    const fileName = await seedDeadLetter("key-2");
    const original = buildMessage("key-2");

    const outcome = await store.requeue(fileName);
    expect(outcome).toBe("requeued");

    const outboxFile = path.join(
      baseDirectory,
      "feedback-client-outbox",
      fileNameFor("key-2"),
    );
    const requeued = JSON.parse(await fs.readFile(outboxFile, "utf8")) as FeedbackMessage;
    expect(requeued).toEqual(original);
    await expect(fs.access(path.join(store.directoryPath, fileName))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.requeue(fileName)).resolves.toBe("not-found");
  });

  it("③ 同键消息已在补送队列 ⇒ already-queued，死信保留", async () => {
    const fileName = await seedDeadLetter("key-3");
    await writeAtomicJson(
      path.join(baseDirectory, "feedback-client-outbox", fileNameFor("key-3")),
      buildMessage("key-3"),
    );
    await expect(store.requeue(fileName)).resolves.toBe("already-queued");
    await expect(fs.access(path.join(store.directoryPath, fileName))).resolves.toBeUndefined();
  });

  it("④ 文件名防穿越：只接受 64 位十六进制 .json", async () => {
    await expect(store.requeue("../escape.json")).resolves.toBe("invalid");
    await expect(store.remove("../escape.json")).resolves.toBe(false);
    await expect(store.read("../../etc/passwd")).resolves.toBeNull();
  });

  it("⑤ remove 显式清除；不存在时返回 false", async () => {
    const fileName = await seedDeadLetter("key-5");
    await expect(store.remove(fileName)).resolves.toBe(true);
    await expect(store.remove(fileName)).resolves.toBe(false);
  });
});
