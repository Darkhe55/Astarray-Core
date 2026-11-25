/**
 * B9（2026-11-25）：损坏矩阵续 + 导出/未登记失败分支。
 *
 * 覆盖：AgentTaskSequenceStore 与 GoalDispatchVerdictJournal 的损坏读回、
 * goal-mode verdicts 导出写失败、doctor provider 未登记。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  AGENT_TASK_SEQUENCE_SCHEMA_VERSION,
} from "../../../packages/core/src/core/types.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { GoalDispatchVerdictJournal } from "../../../packages/core/src/orchestration/goal-dispatch-verdict-journal.js";
import { executeDoctorProviderCommand } from "../../../packages/tui/src/cli/commands.js";
import { executeGoalModeVerdictsCommand as executeVerdictsCommand } from "../../../packages/tui/src/cli/goal-mode-command.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b9-more-"));
  captured = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const text = (): string => captured.join("");

async function corruptAllJsonFiles(): Promise<void> {
  const walk = async (directoryPath: string): Promise<void> => {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.name.endsWith(".json") && !entry.name.endsWith(".bak")) {
        await fs.writeFile(fullPath, "{ 损坏", "utf8");
      }
    }
  };
  await walk(stateDirectory);
}

describe("B9：损坏矩阵续 + 失败分支", () => {
  it("① AgentTaskSequenceStore：损坏 ⇒ readSequence 不返回可用序列", async () => {
    const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
    await store.writeSequenceDirect({
      schemaVersion: AGENT_TASK_SEQUENCE_SCHEMA_VERSION,
      sequenceId: "seq-1",
      ownerAgentInstanceId: "agent-1",
      revision: 1,
      updatedAtIso: "2026-11-25T00:00:00.000Z",
      nodes: [],
      bundles: [],
      auditEntries: [],
    } as never);
    await corruptAllJsonFiles();
    const sequence = await store.readSequence("agent-1", "seq-1").catch(() => null);
    /** 允许：显式失败（null）或从 .bak 恢复出同一序列；不得凭空改写内容。 */
    expect(sequence === null || sequence.sequenceId === "seq-1").toBe(true);
  });

  it("② GoalDispatchVerdictJournal：损坏 ⇒ 读回空记录（不伪造判定）", async () => {
    const journal = new GoalDispatchVerdictJournal({ baseDirectory: stateDirectory });
    await journal.record({
      missionIdentifier: "mission-1",
      projectIdentifier: "project-1",
      contractRevision: 1,
      isAllowed: true,
      reasonCode: null,
      detail: null,
      evidenceGaps: [],
      isEnforced: false,
      observedAtIso: "2026-11-25T00:00:00.000Z",
    });
    await corruptAllJsonFiles();
    /** 允许两种如实处理：抛错（显式失败）或读回空记录；不得返回旧判定。 */
    const document = await journal.read().catch(() => null);
    expect(document === null || document.records.length === 0).toBe(true);
  });

  it("③ goal-mode verdicts 导出到目录路径 ⇒ 退出码 2（写失败不谎报成功）", async () => {
    const exitCode = await executeVerdictsCommand({
      stateDirectory,
      recentCount: 5,
      isJsonOutput: false,
      exportPath: stateDirectory,
    } as never);
    expect(exitCode).toBe(2);
    expect(text()).toContain("导出判定记录失败");
  });

  it("④ doctor provider 未登记 ⇒ 抛错（不返回虚假健康）", async () => {
    await expect(
      executeDoctorProviderCommand({
        stateDirectory,
        providerProfileId: "provider-missing",
        isJsonOutput: true,
      } as never),
    ).rejects.toThrow("Provider 未登记");
  });
});
