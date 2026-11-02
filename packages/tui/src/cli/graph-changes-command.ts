/**
 * R132（2026-11-02）：`graph-changes` —— 只读查看任务图变更审计。
 *
 * 只读：不写状态、不改图；只展示变更类型、任务、变更前后依赖/描述/工具名。
 */
import { TaskGraphChangeJournalStore } from "../../../core/src/orchestration/task-graph-change-journal.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface GraphChangesCommandInput {
  readonly stateDirectory: string;
  readonly missionIdentifier: string;
  readonly isJsonOutput: boolean;
}

export async function executeGraphChangesCommand(
  input: GraphChangesCommandInput,
): Promise<number> {
  const store = new TaskGraphChangeJournalStore({
    baseDirectory: input.stateDirectory,
  });
  const entries = await store.listForMission(input.missionIdentifier);
  if (input.isJsonOutput) {
    printJson({
      status: "graph-changes",
      missionIdentifier: input.missionIdentifier,
      count: entries.length,
      entries,
    });
  } else {
    process.stdout.write(
      `mission ${input.missionIdentifier} 图变更：${String(entries.length)} 条\n`,
    );
    for (const entry of entries) {
      process.stdout.write(
        `- ${entry.recordedAtIso} ${entry.changeKind} ${entry.taskIdentifier} 依赖 ${JSON.stringify(entry.before?.dependsOn ?? null)} → ${JSON.stringify(entry.after?.dependsOn ?? null)}\n`,
      );
    }
  }
  return EXIT_CODES.SUCCESS;
}
