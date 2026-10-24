/**
 * COMM-01-03（2026-10-24）：`collaboration status` 只读 CLI。
 *
 * 只读：不投递、不改归属、不写盘；空状态明确写"空 ≠ 不存在"。
 */
import { AgentCreationRegistry } from "../../../core/src/orchestration/agent-parent-binding-store.js";
import { buildCollaborationStatusFromState } from "../../../core/src/orchestration/collaboration-status.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface CollaborationStatusCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
}

export async function executeCollaborationStatusCommand(
  input: CollaborationStatusCommandInput,
): Promise<number> {
  const registry = new AgentCreationRegistry({ stateDirectory: input.stateDirectory });
  const snapshot = await buildCollaborationStatusFromState({
    stateDirectory: input.stateDirectory,
    registry,
  });

  if (input.isJsonOutput) {
    printJson({
      status: "ok",
      agents: snapshot.agents,
      deliveries: snapshot.deliveries,
      view: snapshot.view,
      inboxFileCount: snapshot.inboxFileCount,
      invalidInboxCount: snapshot.invalidInboxCount,
      notice: snapshot.notice,
    });
    return EXIT_CODES.SUCCESS;
  }

  process.stdout.write(
    [
      "Agent 数：" + String(snapshot.agents.length),
      "投递记录：" + String(snapshot.deliveries.length),
      "应收件箱文件：" + String(snapshot.inboxFileCount) +
        (snapshot.invalidInboxCount > 0 ? "（不可读 " + String(snapshot.invalidInboxCount) + "）" : ""),
      "可投递节点：" + String(snapshot.view.deliverableCount),
      "暂停：" + String(snapshot.view.pausedCount) + "，丢弃：" + String(snapshot.view.droppedCount),
      "是否存在环：" + (snapshot.view.hasCycle ? "是" : "否"),
      "只读：" + (snapshot.view.isWritable ? "否" : "是"),
      snapshot.notice,
    ].join("\n") + "\n",
  );
  return EXIT_CODES.SUCCESS;
}
