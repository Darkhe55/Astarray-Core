/**
 * R125（2026-11-01）：扫描记录持久化的单测。
 *
 * - 追加后可读回；
 * - 超过上限 ⇒ 挤出最旧并累计 droppedRecordCount；
 * - 只读入口能读到。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PromptScanJournalStore } from "../../packages/core/src/orchestration/prompt-scan-journal-store.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function record(index: number) {
  return {
    missionIdentifier: `mission-${String(index)}`,
    agentInstanceIdentifier: "worker:1",
    taskIdentifier: "T-001",
    outcome: "clean",
    ruleSetVersion: 1,
    matchedRuleIdentifiers: [],
    limitReason: null,
    isClean: true,
    recordedAtIso: `2026-11-01T00:00:0${String(index)}.000Z`,
  };
}

describe("扫描记录持久化", () => {
  it("追加后可读回，按时间保留", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-scan-journal-"));
    directories.push(directory);
    const store = new PromptScanJournalStore({ baseDirectory: directory });
    await store.append(record(1));
    await store.append(record(2));
    const document = await store.read();
    expect(document.records).toHaveLength(2);
    expect(document.records[0]?.missionIdentifier).toBe("mission-1");
    expect(document.droppedRecordCount).toBe(0);
  });

  it("超过上限 ⇒ 挤出最旧并累计丢弃计数", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-scan-journal-"));
    directories.push(directory);
    const store = new PromptScanJournalStore({ baseDirectory: directory });
    // 直接写一个小上限文档，避免测试真的写 101 次。
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(directory, "prompt-scan-journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        documentRevision: 1,
        maximumRecords: 2,
        droppedRecordCount: 0,
        records: [record(1), record(2)],
      }),
      "utf8",
    );
    await store.append(record(3));
    const document = await store.read();
    expect(document.records).toHaveLength(2);
    expect(document.records[0]?.missionIdentifier).toBe("mission-2");
    expect(document.droppedRecordCount).toBe(1);
  });
});
