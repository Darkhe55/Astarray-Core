/**
 * WIRING-04-02：同一消息被多次模型迭代携带时，回执必须**按迭代分别留痕**。
 *
 * 断言：
 * - 两次不同 requestIdentifier ⇒ 两条 attempt（各自 iterationIndex/指纹）；
 * - 同一 requestIdentifier 重复记录 ⇒ 幂等（不重复追加）；
 * - 首次投递时间不被后续迭代覆盖。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextAdmissionController } from "../../../packages/core/src/orchestration/context-admission.js";

vi.setConfig({ testTimeout: 60_000 });

const PARTITION_KEY = "partition-1";
let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-attempts-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function seedAdmission(admission: ContextAdmissionController) {
  await admission.admit({
    partitionKey: PARTITION_KEY,
    recipientIdentifier: "agent:worker-1",
    messageIdentifier: "message-1",
    admissionClass: "requires-model-decision",
  });
}

describe("WIRING-04-02：多迭代投递留痕", () => {
  it("① 两次迭代 ⇒ 两条 attempt，首次投递时间不被覆盖", async () => {
    const admission = new ContextAdmissionController({ stateDirectory });
    await seedAdmission(admission);

    const first = await admission.recordDelivered({
      partitionKey: PARTITION_KEY,
      messageIdentifier: "message-1",
      requestIdentifier: "request-1",
      payloadFingerprint: "fp-1",
      iterationIndex: 0,
      deliveredAtIso: "2026-11-17T00:00:00.000Z",
    });
    const second = await admission.recordDelivered({
      partitionKey: PARTITION_KEY,
      messageIdentifier: "message-1",
      requestIdentifier: "request-2",
      payloadFingerprint: "fp-2",
      iterationIndex: 1,
    });

    expect(second.receipt?.deliveredAtIso).toBe("2026-11-17T00:00:00.000Z");
    expect(second.receipt?.deliveryAttempts?.map((attempt) => attempt.requestIdentifier)).toEqual([
      "request-1",
      "request-2",
    ]);
    expect(second.receipt?.deliveryAttempts?.map((attempt) => attempt.iterationIndex)).toEqual([0, 1]);
    expect(first.receipt?.deliveryRequestIdentifier).toBe("request-1");
  });

  it("② 同一 requestIdentifier 重复记录 ⇒ 幂等（不重复追加）", async () => {
    const admission = new ContextAdmissionController({ stateDirectory });
    await seedAdmission(admission);

    await admission.recordDelivered({
      partitionKey: PARTITION_KEY,
      messageIdentifier: "message-1",
      requestIdentifier: "request-1",
      iterationIndex: 0,
    });
    const repeated = await admission.recordDelivered({
      partitionKey: PARTITION_KEY,
      messageIdentifier: "message-1",
      requestIdentifier: "request-1",
      iterationIndex: 0,
    });

    expect(repeated.outcome).toBe("already-delivered");
    expect(repeated.receipt?.deliveryAttempts).toHaveLength(1);
  });
});
