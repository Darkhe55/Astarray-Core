/**
 * R121（2026-11-01）：`task-ledger apply-writeback` CLI 的真实存储端到端（临时目录）。
 *
 * 覆盖：提案 → 应用（T-01 done、revision 前进、审计追加）→ 旧 revision 再应用被拒。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeTaskLedgerApplyWriteBackCommand } from "../../packages/tui/src/cli/task-ledger-command.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createFixture(): Promise<string> {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-wb-cli-"));
  directories.push(stateDirectory);
  const now = "2026-11-01T00:00:00.000Z";
  await mkdir(path.join(stateDirectory, "missions", "mission-wb"), { recursive: true });
  await writeFile(
    path.join(stateDirectory, "missions", "mission-wb", "task-chain.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: "mission-wb",
      revision: 2,
      updatedAtIso: now,
      tasks: [
        {
          id: "T-01",
          description: "write fixture file",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
          assignedAgentId: null,
          status: "done",
          resultLocation: null,
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(stateDirectory, "missions", "mission-wb", "summary.json"),
    JSON.stringify({
      missionId: "mission-wb",
      mode: "assist",
      status: "done",
      prompt: "write fixture file",
      taskPlanningOutcome: "model",
    }),
    "utf8",
  );
  const sequenceDirectory = path.join(
    stateDirectory,
    "agent-memory",
    "scheduler~003amission-wb",
    "task-sequences",
    "sequence-wb",
  );
  await mkdir(sequenceDirectory, { recursive: true });
  await writeFile(
    path.join(sequenceDirectory, "task-sequence.json"),
    JSON.stringify({
      schemaVersion: 1,
      sequenceId: "sequence-wb",
      ownerAgentInstanceId: "scheduler:mission-wb",
      revision: 2,
      updatedAtIso: now,
      bundles: [],
      auditEntries: [
        {
          auditEntryId: "audit-wb-publish",
          recordedAtIso: now,
          mutationKind: "publish",
          actorSourceKind: "user",
          actorId: "user-local",
          summary: "发布序列 sequence-wb",
        },
      ],
      nodes: [
        {
          taskId: "T-01",
          title: "write fixture file",
          dependsOn: [],
          sourceKind: "user",
          publisherId: "user-local",
          priorityTier: 0,
          status: "pending",
          blockReason: null,
          externalReference: "mission:mission-wb",
          sequenceOrdinal: 1,
          createdAtIso: now,
        },
      ],
    }),
    "utf8",
  );
  await mkdir(path.join(stateDirectory, "task-ledger"), { recursive: true });
  await writeFile(
    path.join(stateDirectory, "task-ledger", "mission-sequences.json"),
    JSON.stringify({
      schemaVersion: 1,
      documentRevision: 1,
      bindings: [
        {
          missionIdentifier: "mission-wb",
          sequenceIdentifier: "sequence-wb",
          ownerAgentInstanceIdentifier: "scheduler:mission-wb",
          boundAtIso: now,
        },
      ],
    }),
    "utf8",
  );
  return stateDirectory;
}

describe("task-ledger apply-writeback", () => {
  it("应用 mark-sequence-done：任务 done、revision 前进、审计追加；旧 revision 再应用被拒", async () => {
    const stateDirectory = await createFixture();
    const appliedExitCode = await executeTaskLedgerApplyWriteBackCommand({
      stateDirectory,
      missionIdentifier: "mission-wb",
      approvedBy: "user-local",
      expectedSequenceRevision: 2,
      isJsonOutput: true,
    });
    expect(appliedExitCode).toBe(0);
    const sequence = JSON.parse(
      await readFile(
        path.join(
          stateDirectory,
          "agent-memory",
          "scheduler~003amission-wb",
          "task-sequences",
          "sequence-wb",
          "task-sequence.json",
        ),
        "utf8",
      ),
    ) as { revision: number; nodes: { status: string }[]; auditEntries: unknown[] };
    expect(sequence.nodes[0]?.status).toBe("done");
    expect(sequence.revision).toBeGreaterThan(2);
    expect(sequence.auditEntries.length).toBeGreaterThan(1);

    const staleExitCode = await executeTaskLedgerApplyWriteBackCommand({
      stateDirectory,
      missionIdentifier: "mission-wb",
      approvedBy: "user-local",
      expectedSequenceRevision: 2,
      isJsonOutput: true,
    });
    expect(staleExitCode).not.toBe(0);
  });

  it("没有绑定索引 ⇒ index-missing（不猜测）", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-wb-cli-"));
    directories.push(stateDirectory);
    const exitCode = await executeTaskLedgerApplyWriteBackCommand({
      stateDirectory,
      missionIdentifier: "mission-none",
      approvedBy: "user-local",
      expectedSequenceRevision: 1,
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
  });
});
