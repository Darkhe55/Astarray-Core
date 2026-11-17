/**
 * WIRING-04-02（2026-11-17）：投递顺序与启动补写。
 *
 * - 顺序：**先写准入回执，再更新邮箱投影**（失败可恢复）；
 * - 投影失败 ⇒ 启动按回执补写，不重发模型请求；
 * - 未投递的消息不被补写成 delivered（必须有回执证据）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { ContextAdmissionController } from "../../../packages/core/src/orchestration/context-admission.js";
import {
  createCoordinationContextDeliveryPort,
  reconcileContextDeliveryProjection,
} from "../../../packages/core/src/orchestration/coordination-context-delivery.js";

vi.setConfig({ testTimeout: 60_000 });

const PARTITION_KEY = "partition-1";
const RECIPIENT = "agent:worker-1";
let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-projection-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function seedAdmitted(journal: MailboxJournal, admission: ContextAdmissionController) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId: "message-1",
    source: { sourceType: "agent", agentInstanceId: "agent-requester" },
    recipientId: RECIPIENT,
    priority: "state",
    createdAtIso: "2026-11-17T00:00:00.000Z",
    idempotencyKey: "message-1",
    payload: { kind: "success", summary: "需要确认" },
  } as never);
  await admission.admit({
    partitionKey: PARTITION_KEY,
    recipientIdentifier: RECIPIENT,
    messageIdentifier: "message-1",
    admissionClass: "requires-model-decision",
  });
}

describe("WIRING-04-02：投递顺序与启动补写", () => {
  it("① 投影写失败 ⇒ 回执已落、邮箱仍 pending；启动补写把邮箱补成 delivered", async () => {
    const journal = new MailboxJournal(stateDirectory);
    const admission = new ContextAdmissionController({ stateDirectory });
    await seedAdmitted(journal, admission);

    /** 构造"邮箱投影失败"：只让 setContextDeliveryState 抛错，其余照常。 */
    const failingJournal = new Proxy(journal, {
      get(target, property, receiver) {
        if (property === "setContextDeliveryState") {
          return async () => {
            throw new Error("磁盘满");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const port = createCoordinationContextDeliveryPort({
      journal: failingJournal,
      admissionController: admission,
      partitionKey: PARTITION_KEY,
    });

    await expect(
      port.markDelivered({
        recipientId: RECIPIENT,
        messageIdentifiers: ["message-1"],
        requestIdentifier: "request-1",
        payloadFingerprint: "fingerprint-1",
      }),
    ).rejects.toThrow(/磁盘满/u);

    const receipt = await admission.readInjectionReceipt({
      partitionKey: PARTITION_KEY,
      messageIdentifier: "message-1",
    });
    expect(receipt?.deliveredAtIso).not.toBeNull();
    expect(receipt?.payloadFingerprint).toBe("fingerprint-1");

    const [viewBefore] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "message-1",
    });
    expect(viewBefore?.contextDeliveryState).toBe("not-required");

    const result = await reconcileContextDeliveryProjection({
      journal,
      admissionController: admission,
      partitionKey: PARTITION_KEY,
    });
    expect(result.backfilledMessageCount).toBe(1);

    const [viewAfter] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "message-1",
    });
    expect(viewAfter?.contextDeliveryState).toBe("delivered");
  });

  it("② 没有回执证据的消息不会被补写成 delivered", async () => {
    const journal = new MailboxJournal(stateDirectory);
    const admission = new ContextAdmissionController({ stateDirectory });
    await seedAdmitted(journal, admission);

    const result = await reconcileContextDeliveryProjection({
      journal,
      admissionController: admission,
      partitionKey: PARTITION_KEY,
    });
    expect(result.backfilledMessageCount).toBe(0);

    const [view] = await journal.readMessageStatusView({
      recipientId: RECIPIENT,
      messageId: "message-1",
    });
    expect(view?.contextDeliveryState).toBe("not-required");
  });
});
