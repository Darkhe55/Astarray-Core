/**
 * EVENT-01 事故日志 + `event status` 只读 CLI 反例（2026-10-24）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventIncidentJournal,
} from "../../../packages/core/src/orchestration/event-incident-journal.js";
import { EventControlChannel } from "../../../packages/core/src/orchestration/event-control-channel.js";
import { executeEventStatusCommand } from "../../../packages/tui/src/cli/event-command.js";

const temporaryDirectories: string[] = [];
async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-event-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function snapshotWithIncident() {
  const channel = new EventControlChannel({ maximumConcurrentIncidents: 2, responseDeadlineSeconds: 60 });
  channel.registerToolCapabilities([{ toolName: "readFile", supportsCancellation: true }]);
  channel.receiveEvent({
    kind: "process-exit",
    resourceKey: "r1",
    severity: "critical",
    epoch: 3,
    receivedAtIso: "2026-10-24T00:00:00.000Z",
  });
  return channel.toSnapshot();
}

describe("EVENT-01 事故日志", () => {
  it("① 保存后可读回（revision、事故状态保留）", async () => {
    const stateDirectory = await createStateDirectory();
    const journal = new EventIncidentJournal({ stateDirectory });
    const saved = await journal.save({
      snapshot: snapshotWithIncident(),
      expectedRevision: 0,
      updatedAtIso: "2026-10-24T00:00:01.000Z",
    });
    expect(saved.revision).toBe(1);
    const read = await journal.read();
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid") return;
    expect(read.record.snapshot.incidents[0]?.state).toBe("received");
    expect(read.record.snapshot.incidents[0]?.epoch).toBe(3);
  });

  it("② 陈旧 revision 被拒；未写入过 ⇒ absent", async () => {
    const stateDirectory = await createStateDirectory();
    const journal = new EventIncidentJournal({ stateDirectory });
    expect((await journal.read()).kind).toBe("absent");
    await journal.save({ snapshot: snapshotWithIncident(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:01.000Z" });
    await expect(
      journal.save({ snapshot: snapshotWithIncident(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:02.000Z" }),
    ).rejects.toThrow(/revision/i);
  });

  it("③ 损坏日志 ⇒ invalid 且不覆盖", async () => {
    const stateDirectory = await createStateDirectory();
    const journal = new EventIncidentJournal({ stateDirectory });
    await mkdir(path.dirname(journal.pathFor()), { recursive: true });
    await writeFile(journal.pathFor(), "{broken", "utf8");
    const before = await readFile(journal.pathFor(), "utf8");
    const read = await journal.read();
    expect(read.kind).toBe("invalid");
    await expect(
      journal.save({ snapshot: snapshotWithIncident(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:01.000Z" }),
    ).rejects.toThrow();
    expect(await readFile(journal.pathFor(), "utf8")).toBe(before);
  });
});

describe("EVENT-01 event status CLI", () => {
  it("④ 无记录 ⇒ 空 ≠ 无事件，退出码 0", async () => {
    const stateDirectory = await createStateDirectory();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeEventStatusCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.isPresent).toBe(false);
    expect(payload.notice).toContain("空 ≠ 无事件");
  });

  it("⑤ 有记录 ⇒ 输出事故且只读；损坏 ⇒ 退出码 2", async () => {
    const stateDirectory = await createStateDirectory();
    const journal = new EventIncidentJournal({ stateDirectory });
    await journal.save({ snapshot: snapshotWithIncident(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:01.000Z" });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeEventStatusCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.isPresent).toBe(true);
    expect(payload.incidents[0].severity).toBe("critical");
    expect(payload.notice).toContain("只读");

    const brokenDirectory = await createStateDirectory();
    const brokenJournal = new EventIncidentJournal({ stateDirectory: brokenDirectory });
    await mkdir(path.dirname(brokenJournal.pathFor()), { recursive: true });
    await writeFile(brokenJournal.pathFor(), "{bad", "utf8");
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });
    const brokenExit = await executeEventStatusCommand({ stateDirectory: brokenDirectory, isJsonOutput: true });
    expect(brokenExit).toBe(2);
    expect(errors.join("")).toContain("不可读");
  });
});
