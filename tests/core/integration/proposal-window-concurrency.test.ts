/**
 * WIRING-04 §36.2 反例：契约提案确认 + 工作时段推迟队列（2026-11-19）。
 *
 * - 提案确认是**一次性**语义：两实例并发确认同一提案到不同目标，只有一个能成功。
 * - 推迟队列是累积型：并发登记若互相覆盖，推迟任务会**永久丢失**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoalContractProposalStore } from "../../../packages/core/src/orchestration/goal-contract-proposal.js";
import { WorkWindowDeferredMissionStore } from "../../../packages/core/src/orchestration/work-window-deferred-mission-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-window-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

describe("契约提案确认并发", () => {
  it("① 两实例并发确认同一提案到不同目标 ⇒ 只有一个成功，另一个 journal-corrupted", async () => {
    const firstStore = new GoalContractProposalStore({ baseDirectory: stateDirectory });
    const secondStore = new GoalContractProposalStore({ baseDirectory: stateDirectory });
    await firstStore.save({
      schemaVersion: 1,
      proposalIdentifier: "proposal-1",
      sourceRequestReference: "request-1",
      draft: {
        objectiveText: "把文档补完",
        requirements: [
          {
            requirementIdentifier: "req-1",
            description: "写完说明",
            weight: 1,
            completionPredicateKind: "deterministic-check",
          },
        ],
        scope: { projectIdentifiers: [], allowedToolNames: null },
        nonViolableInvariants: [],
        resourceLimits: {
          maximumToolCalls: null,
          maximumWallClockSeconds: null,
          maximumCostUnits: null,
        },
        deadlineIso: null,
        pauseConditions: [],
      },
      createdAtIso: "2026-11-18T00:00:00.000Z",
      expiresAtIso: "2026-12-31T00:00:00.000Z",
      confirmedAtIso: null,
      confirmedGoalIdentifier: null,
    } as never);

    const results = await Promise.allSettled([
      firstStore.markConfirmed({
        proposalIdentifier: "proposal-1",
        confirmedGoalIdentifier: "goal-a",
        confirmedAtIso: "2026-11-18T00:00:01.000Z",
      }),
      secondStore.markConfirmed({
        proposalIdentifier: "proposal-1",
        confirmedGoalIdentifier: "goal-b",
        confirmedAtIso: "2026-11-18T00:00:02.000Z",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect((rejection?.reason as { errorCode?: string }).errorCode).toBe("journal-corrupted");

    const stored = await new GoalContractProposalStore({ baseDirectory: stateDirectory }).read(
      "proposal-1",
    );
    expect(["goal-a", "goal-b"]).toContain(stored?.confirmedGoalIdentifier);
  }, 60_000);
});

describe("工作时段推迟队列并发", () => {
  it("② 两实例并发登记 40 个 mission ⇒ 40 条记录都保留", async () => {
    const firstStore = new WorkWindowDeferredMissionStore({ baseDirectory: stateDirectory });
    const secondStore = new WorkWindowDeferredMissionStore({ baseDirectory: stateDirectory });
    const records: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      records.push(
        firstStore.record({
          missionIdentifier: `mission-a-${String(index)}`,
          projectIdentifier: "project-alpha",
          reason: "工作时段关闭",
        }),
        secondStore.record({
          missionIdentifier: `mission-b-${String(index)}`,
          projectIdentifier: "project-alpha",
          reason: "工作时段关闭",
        }),
      );
    }
    await Promise.all(records);

    const stored = await new WorkWindowDeferredMissionStore({
      baseDirectory: stateDirectory,
    }).list();
    expect(stored).toHaveLength(40);
  }, 60_000);
});
