/**
 * 台账分歧日志（此前 `tests/` 零引用）：**只记录、不修复**，且去重不能吞掉别的 mission。
 *
 * 反例优先：
 * - 连续相同差异只记一次（避免刷屏）；
 * - 非连续（A,B,A）必须各记一次；
 * - **不同 mission 的相同漂移必须分别记录**（去重键包含 mission/sequence，否则历史被静默吞掉）；
 * - 超上限丢最旧；文档损坏读作空而不是抛错。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION,
  TaskLedgerDivergenceJournal,
  buildTaskLedgerDivergenceEntry,
} from "../../../packages/core/src/orchestration/task-ledger-divergence-journal.js";
import type { TaskLedgerDivergenceEntry } from "../../../packages/core/src/orchestration/task-ledger-divergence-journal.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-divergence-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildEntry(options: {
  missionIdentifier?: string;
  sequenceId?: string;
  sequenceRevision?: number;
  onlySequence?: string[];
  recordedAtIso?: string;
  trigger?: string;
} = {}): TaskLedgerDivergenceEntry {
  return buildTaskLedgerDivergenceEntry({
    report: {
      missionIdentifier: options.missionIdentifier ?? "mission-1",
      sequenceId: options.sequenceId ?? "sequence-1",
      sequenceRevision: options.sequenceRevision ?? 3,
      sequenceTaskIdentifiers: ["T-001", "T-002"],
      missionTaskIdentifiers: ["T-001"],
      tasksOnlyInSequence: options.onlySequence ?? ["T-002"],
      tasksOnlyInMission: [],
      statusMismatches: [],
    },
    recordedAtIso: options.recordedAtIso ?? "2026-11-12T00:00:00.000Z",
    trigger: options.trigger ?? "manual-check",
  });
}

describe("台账分歧日志", () => {
  it("① 没有日志文件 ⇒ 空文档（schema 版本正确、0 条）", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory });
    const document = await journal.read();
    expect(document.schemaVersion).toBe(TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION);
    expect(document.entries).toEqual([]);
    expect(document.documentRevision).toBe(0);
  });

  it("② 追加 ⇒ recorded=true 且 revision 递增", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory });
    expect((await journal.append(buildEntry())).recorded).toBe(true);
    const document = await journal.read();
    expect(document.entries).toHaveLength(1);
    expect(document.documentRevision).toBe(1);
  });

  it("③ 连续相同差异 ⇒ 只记一次（不刷屏）", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory });
    await journal.append(buildEntry());
    const second = await journal.append(
      buildEntry({ recordedAtIso: "2026-11-12T01:00:00.000Z", trigger: "after-insert" }),
    );
    expect(second.recorded).toBe(false);
    expect((await journal.read()).entries).toHaveLength(1);
  });

  it("④ 非连续（A,B,A）⇒ 各记一次（只与上一条比较）", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory });
    await journal.append(buildEntry({ sequenceRevision: 3 }));
    await journal.append(buildEntry({ sequenceRevision: 4 }));
    await journal.append(buildEntry({ sequenceRevision: 3 }));
    expect((await journal.read()).entries).toHaveLength(3);
  });

  it("⑤ **不同 mission 的相同漂移必须分别记录**（去重不得吞掉别人的历史）", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory });
    await journal.append(buildEntry({ missionIdentifier: "mission-1" }));
    const otherMission = await journal.append(buildEntry({ missionIdentifier: "mission-2" }));
    expect(otherMission.recorded).toBe(true);
    const entries = (await journal.read()).entries;
    expect(entries.map((entry) => entry.missionIdentifier)).toEqual(["mission-1", "mission-2"]);
  });

  it("⑥ 超过上限 ⇒ 丢弃最旧、保留最新", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory, maximumEntries: 2 });
    await journal.append(buildEntry({ sequenceRevision: 1 }));
    await journal.append(buildEntry({ sequenceRevision: 2 }));
    await journal.append(buildEntry({ sequenceRevision: 3 }));
    const entries = (await journal.read()).entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.sequenceRevision)).toEqual([2, 3]);
  });

  it("⑦ 文档损坏 ⇒ 读作空（不抛错）；readRecent(0) ⇒ 空", async () => {
    const journal = new TaskLedgerDivergenceJournal({ baseDirectory });
    const directory = path.join(baseDirectory, "task-ledger-divergence");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "journal.json"), JSON.stringify({ entries: "nope" }), "utf8");
    const document = await journal.read();
    expect(document.entries).toEqual([]);
    expect(await journal.readRecent(0)).toEqual([]);
  });
});
