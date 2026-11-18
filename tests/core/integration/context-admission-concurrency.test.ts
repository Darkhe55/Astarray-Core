/**
 * 准入/投递回执跨实例并发（2026-11-18）。
 *
 * 这些回执是"崩溃后要对账"的证据：漏一条就等于**重复投递**或**永久未投递**。
 * 两个独立实例并发写同一分区，读-改-写必须串行化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextAdmissionController } from "../../../packages/core/src/orchestration/context-admission.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "admission-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildController(): ContextAdmissionController {
  return new ContextAdmissionController({
    stateDirectory,
    nowUnixMilliseconds: () => Date.parse("2026-11-18T00:00:00.000Z"),
  });
}

describe("准入回执跨实例并发", () => {
  it("① 两个实例并发准入 40 条 ⇒ 40 条回执全部落盘", async () => {
    const firstController = buildController();
    const secondController = buildController();
    const admissions: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      admissions.push(
        firstController.admit({
          partitionKey: "partition-1",
          recipientIdentifier: "agent-1",
          messageIdentifier: `message-a-${String(index)}`,
          admissionClass: "requires-model-decision",
        }),
        secondController.admit({
          partitionKey: "partition-1",
          recipientIdentifier: "agent-1",
          messageIdentifier: `message-b-${String(index)}`,
          admissionClass: "requires-model-decision",
        }),
      );
    }
    await Promise.all(admissions);

    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "partition-1.json"), "utf8"),
    ) as { receipts: Array<{ messageIdentifier: string }> };
    expect(document.receipts).toHaveLength(40);
  }, 90_000);

  it("② 两个实例并发记录同一条消息的投递 ⇒ 只留一份首投时间与 one attempt", async () => {
    const firstController = buildController();
    const secondController = buildController();
    await firstController.admit({
      partitionKey: "partition-2",
      recipientIdentifier: "agent-1",
      messageIdentifier: "message-1",
      admissionClass: "requires-model-decision",
    });
    await Promise.all([
      firstController.recordDelivered({
        partitionKey: "partition-2",
        messageIdentifier: "message-1",
        requestIdentifier: "request-1",
      }),
      secondController.recordDelivered({
        partitionKey: "partition-2",
        messageIdentifier: "message-1",
        requestIdentifier: "request-1",
      }),
    ]);
    const receipt = await buildController().readInjectionReceipt({
      partitionKey: "partition-2",
      messageIdentifier: "message-1",
    });
    expect(receipt?.deliveredAtIso).not.toBeNull();
    expect(receipt?.deliveryAttempts).toHaveLength(1);
  }, 90_000);
});
