/**
 * 扫描日志与账本差异日志的跨实例并发（2026-11-18）。
 *
 * 两者都是"追加型"日志：丢条目会让后续排查/对账缺少依据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptScanJournalStore } from "../../../packages/core/src/orchestration/prompt-scan-journal-store.js";
import { TaskLedgerDivergenceJournal } from "../../../packages/core/src/orchestration/task-ledger-divergence-journal.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "journal-append-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

describe("追加型日志跨实例并发", () => {
  it("① 两个实例并发追加 40 条扫描记录 ⇒ 40 条全部保留", async () => {
    const firstStore = new PromptScanJournalStore({ baseDirectory: stateDirectory });
    const secondStore = new PromptScanJournalStore({ baseDirectory: stateDirectory });
    const appends: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      appends.push(
        firstStore.append({
          missionIdentifier: `mission-a-${String(index)}`,
          agentInstanceIdentifier: "agent-1",
          taskIdentifier: `T-a-${String(index)}`,
          outcome: "clean",
          ruleSetVersion: 1,
          matchedRuleIdentifiers: [],
          limitReason: null,
          isClean: true,
          recordedAtIso: "2026-11-18T00:00:00.000Z",
        } as never),
        secondStore.append({
          missionIdentifier: `mission-b-${String(index)}`,
          agentInstanceIdentifier: "agent-1",
          taskIdentifier: `T-b-${String(index)}`,
          outcome: "clean",
          ruleSetVersion: 1,
          matchedRuleIdentifiers: [],
          limitReason: null,
          isClean: true,
          recordedAtIso: "2026-11-18T00:00:00.000Z",
        } as never),
      );
    }
    await Promise.all(appends);

    const document = await new PromptScanJournalStore({ baseDirectory: stateDirectory }).read();
    expect(document.records).toHaveLength(40);
  }, 90_000);

  it("② 两个实例并发追加 40 条差异记录 ⇒ 40 条全部保留", async () => {
    const firstJournal = new TaskLedgerDivergenceJournal({ baseDirectory: stateDirectory });
    const secondJournal = new TaskLedgerDivergenceJournal({ baseDirectory: stateDirectory });
    const appends: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      appends.push(
        firstJournal.append({
          recordedAtIso: "2026-11-18T00:00:00.000Z",
          missionIdentifier: `mission-a-${String(index)}`,
          sequenceIdentifier: "sequence-1",
          sequenceRevision: 1,
          sequenceTaskCount: 1,
          missionTaskCount: 1,
          tasksOnlyInSequence: [],
          tasksOnlyInMission: [],
          statusMismatchCount: 0,
          divergenceHash: `sha256:${String(index).padStart(64, "0")}`,
        } as never),
        secondJournal.append({
          recordedAtIso: "2026-11-18T00:00:00.000Z",
          missionIdentifier: `mission-b-${String(index)}`,
          sequenceIdentifier: "sequence-1",
          sequenceRevision: 1,
          sequenceTaskCount: 1,
          missionTaskCount: 1,
          tasksOnlyInSequence: [],
          tasksOnlyInMission: [],
          statusMismatchCount: 0,
          divergenceHash: `sha256:${String(index + 100).padStart(64, "0")}`,
        } as never),
      );
    }
    await Promise.all(appends);

    const document = await new TaskLedgerDivergenceJournal({
      baseDirectory: stateDirectory,
    }).read();
    expect(document.entries).toHaveLength(40);
  }, 90_000);
});
