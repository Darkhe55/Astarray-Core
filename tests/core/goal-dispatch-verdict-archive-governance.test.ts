/**
 * R65（2026-10-30）：归档治理（容量轮转 + 保留份数）的单测。
 *
 * 只测存储行为：归档达到行数上限时轮转为带时间戳的文件，且轮转文件只保留最近 N 份。
 * 不测运行期调用、也不测"归档写失败"分支。
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GoalDispatchVerdictJournal } from "../../packages/core/src/orchestration/goal-dispatch-verdict-journal.js";

const temporaryDirectories: string[] = [];

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-archive-governance-"));
  temporaryDirectories.push(directory);
  return directory;
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
    observedAtIso: "2026-10-30T00:00:00.000Z",
  };
}

async function readLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter((line) => line !== "").length;
  } catch {
    return 0;
  }
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("GoalDispatchVerdictJournal 归档治理", () => {
  it("归档达到行数上限 ⇒ 轮转为带时间戳的文件，且总行数不丢", async () => {
    const directory = await createStateDirectory();
    const journal = new GoalDispatchVerdictJournal({
      baseDirectory: directory,
      maximumRecords: 1,
      maximumArchiveLines: 2,
      archiveRetentionCount: 5,
    });
    /** 写 6 条 ⇒ 活动保留最后 1 条，其余 5 条进入归档（跨轮转）。 */
    for (let index = 1; index <= 6; index += 1) {
      await journal.record(buildEntry(index));
    }
    const goalModeDirectory = path.join(directory, "goal-mode");
    const rotated = (await readdir(goalModeDirectory)).filter((name) =>
      /^dispatch-verdicts-archive-\d{14}-\d+\.jsonl$/.test(name),
    );
    expect(rotated.length).toBeGreaterThan(0);
    const activeLines = await readLines(
      path.join(goalModeDirectory, "dispatch-verdicts-archive.jsonl"),
    );
    let totalArchivedLines = activeLines;
    for (const name of rotated) {
      totalArchivedLines += await readLines(path.join(goalModeDirectory, name));
    }
    expect(totalArchivedLines).toBe(5);
    const document = await journal.read();
    expect(document.records).toHaveLength(1);
    expect(document.droppedRecordCount).toBe(0);
  });

  it("轮转文件只保留最近 N 份（更旧的被删除）", async () => {
    const directory = await createStateDirectory();
    const journal = new GoalDispatchVerdictJournal({
      baseDirectory: directory,
      maximumRecords: 1,
      maximumArchiveLines: 1,
      archiveRetentionCount: 1,
    });
    for (let index = 1; index <= 8; index += 1) {
      await journal.record(buildEntry(index));
    }
    const goalModeDirectory = path.join(directory, "goal-mode");
    const rotated = (await readdir(goalModeDirectory)).filter((name) =>
      /^dispatch-verdicts-archive-\d{14}-\d+\.jsonl$/.test(name),
    );
    expect(rotated.length).toBeLessThanOrEqual(1);
  });
});
