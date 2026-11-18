/**
 * 目标派发结论日志与远端投递发件箱的跨实例并发（2026-11-18）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoalDispatchVerdictJournal } from "../../../packages/core/src/orchestration/goal-dispatch-verdict-journal.js";
import { RemoteDeliveryOutbox } from "../../../packages/core/src/orchestration/remote-delivery-outbox.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-outbox-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

describe("目标结论日志跨实例并发", () => {
  it("① 两个实例并发记录 40 条结论 ⇒ 40 条全部保留", async () => {
    const firstJournal = new GoalDispatchVerdictJournal({ baseDirectory: stateDirectory });
    const secondJournal = new GoalDispatchVerdictJournal({ baseDirectory: stateDirectory });
    const records: Promise<unknown>[] = [];
    const buildEntry = (missionIdentifier: string) => ({
      missionIdentifier,
      projectIdentifier: "project-alpha",
      contractRevision: 1,
      isAllowed: true,
      reasonCode: null,
      detail: null,
      evidenceGaps: [],
      isEnforced: true,
      observedAtIso: "2026-11-18T00:00:00.000Z",
    });
    for (let index = 0; index < 20; index += 1) {
      records.push(
        firstJournal.record(buildEntry(`mission-a-${String(index)}`) as never),
        secondJournal.record(buildEntry(`mission-b-${String(index)}`) as never),
      );
    }
    await Promise.all(records);

    const document = await new GoalDispatchVerdictJournal({
      baseDirectory: stateDirectory,
    }).read();
    expect(document.records).toHaveLength(40);
  }, 90_000);
});

describe("远端投递发件箱跨实例并发", () => {
  it("② 两个实例并发入队 40 个操作 ⇒ 40 条全部保留", async () => {
    const firstOutbox = new RemoteDeliveryOutbox({ baseDirectory: stateDirectory });
    const secondOutbox = new RemoteDeliveryOutbox({ baseDirectory: stateDirectory });
    const buildOperation = (sequence: number) => ({
      operationIdentifier: `operation-${String(sequence)}`,
      interactionRevision: 1,
      exportIdentifier: "export-1",
      bindingIdentifier: "binding-1",
      targetAccountIdentifier: "account-1",
      targetDeviceIdentifier: null,
      contentHash: `sha256:${String(sequence).padStart(64, "0")}`,
      authorizationRevision: 1,
      state: "pending",
      createdAtIso: "2026-11-18T00:00:00.000Z",
      updatedAtIso: "2026-11-18T00:00:00.000Z",
    });
    const enqueues: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      enqueues.push(
        firstOutbox.enqueue(buildOperation(index * 2) as never),
        secondOutbox.enqueue(buildOperation(index * 2 + 1) as never),
      );
    }
    await Promise.all(enqueues);

    const document = await new RemoteDeliveryOutbox({ baseDirectory: stateDirectory }).readDocument();
    expect(document.operations).toHaveLength(40);
  }, 90_000);
});
