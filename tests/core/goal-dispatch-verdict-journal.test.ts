/**
 * R63（2026-10-30）：判定记录"溢出归档"的单测。
 *
 * 只测存储行为：超出上限时旧记录**先归档再裁剪**，活动视图仍有界，且**不算丢弃**。
 * 不测运行期 `onGoalDispatchVerdict` 的接线（需要真实派发）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GoalDispatchVerdictJournal } from "../../packages/core/src/orchestration/goal-dispatch-verdict-journal.js";

const temporaryDirectories: string[] = [];

async function createJournal(maximumRecords: number): Promise<{
  journal: GoalDispatchVerdictJournal;
  directory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-verdict-journal-"));
  temporaryDirectories.push(directory);
  return {
    journal: new GoalDispatchVerdictJournal({
      baseDirectory: directory,
      maximumRecords,
    }),
    directory,
  };
}

function buildEntry(index: number) {
  return {
    missionIdentifier: `mission-${String(index)}`,
    projectIdentifier: "project-a",
    contractRevision: 1,
    isAllowed: true,
    reasonCode: null,
    detail: null,
    evidenceGaps: [],
    isEnforced: false,
    observedAtIso: `2026-10-30T00:00:0${String(index)}.000Z`,
  };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("GoalDispatchVerdictJournal 溢出归档", () => {
  it("超出上限：旧记录进归档，活动视图仍有界，且不计入丢弃", async () => {
    const { journal, directory } = await createJournal(2);

    await journal.record(buildEntry(1));
    await journal.record(buildEntry(2));
    const third = await journal.record(buildEntry(3));

    expect(third.archivedRecordCount).toBe(1);
    expect(third.droppedRecordCount).toBe(0);

    const document = await journal.read();
    expect(document.records).toHaveLength(2);
    expect(document.records.map((record) => record.missionIdentifier)).toEqual([
      "mission-2",
      "mission-3",
    ]);
    expect(document.droppedRecordCount).toBe(0);

    const archivePath = path.join(
      directory,
      "goal-mode",
      "dispatch-verdicts-archive.jsonl",
    );
    const archiveText = await readFile(archivePath, "utf8");
    const archiveLines = archiveText.split(/\r?\n/).filter((line) => line !== "");
    expect(archiveLines).toHaveLength(1);
    expect(JSON.parse(archiveLines[0]).missionIdentifier).toBe("mission-1");
  });

  it("持续写入：每次溢出都追加归档，活动文件始终不超过上限", async () => {
    const { journal, directory } = await createJournal(2);
    for (let index = 1; index <= 5; index += 1) {
      await journal.record(buildEntry(index));
    }
    const document = await journal.read();
    expect(document.records.map((record) => record.missionIdentifier)).toEqual([
      "mission-4",
      "mission-5",
    ]);
    expect(document.droppedRecordCount).toBe(0);

    const archiveText = await readFile(
      path.join(directory, "goal-mode", "dispatch-verdicts-archive.jsonl"),
      "utf8",
    );
    const archiveLines = archiveText.split(/\r?\n/).filter((line) => line !== "");
    expect(archiveLines).toHaveLength(3);
    expect(archiveLines.map((line) => JSON.parse(line).missionIdentifier)).toEqual([
      "mission-1",
      "mission-2",
      "mission-3",
    ]);
  });
});
