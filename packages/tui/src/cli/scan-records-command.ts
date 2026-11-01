/**
 * R125（2026-11-01）：`scan-records` —— 只读查看持久化的提示词扫描记录。
 *
 * 只读：不写状态、不触发扫描、不改变装配；只展示结论字段（不含提示词正文）。
 */
import { PromptScanJournalStore } from "../../../core/src/orchestration/prompt-scan-journal-store.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface ScanRecordsCommandInput {
  readonly stateDirectory: string;
  readonly recentCount: number;
  readonly isJsonOutput: boolean;
}

export async function executeScanRecordsCommand(
  input: ScanRecordsCommandInput,
): Promise<number> {
  const store = new PromptScanJournalStore({
    baseDirectory: input.stateDirectory,
  });
  const document = await store.read();
  const recent = document.records.slice(-input.recentCount);
  if (input.isJsonOutput) {
    printJson({
      status: "scan-records",
      totalCount: document.records.length,
      droppedRecordCount: document.droppedRecordCount,
      maximumRecords: document.maximumRecords,
      recent,
    });
  } else {
    process.stdout.write(
      `扫描记录：持久 ${String(document.records.length)} 条（上限 ${String(document.maximumRecords)}，累计丢弃 ${String(document.droppedRecordCount)}）\n`,
    );
    for (const record of recent) {
      process.stdout.write(
        `- ${record.recordedAtIso} mission=${record.missionIdentifier} task=${record.taskIdentifier} 结论=${record.outcome} clean=${String(record.isClean)}\n`,
      );
    }
  }
  return EXIT_CODES.SUCCESS;
}
