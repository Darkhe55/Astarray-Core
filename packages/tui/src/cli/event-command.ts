/**
 * EVENT-01（2026-10-24）：`event status` 只读 CLI —— **安装包状态入口**。
 *
 * 纪律：
 * - 只读（不写日志、不恢复、不投递、不调模型）；
 * - 无记录 ⇒ 明确写「无事故记录（空 ≠ 无事件）」；
 * - 损坏 ⇒ 退出码 2 并给原因，不静默当空。
 */
import { EventIncidentJournal } from "../../../core/src/orchestration/event-incident-journal.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface EventStatusCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
}

export async function executeEventStatusCommand(
  input: EventStatusCommandInput,
): Promise<number> {
  const journal = new EventIncidentJournal({ stateDirectory: input.stateDirectory });
  const outcome = await journal.read();

  if (outcome.kind === "invalid") {
    process.stderr.write("事故日志不可读（未静默当空）：" + outcome.reason + "\n");
    return 2;
  }
  if (outcome.kind === "absent") {
    const text = "无事故记录（空 ≠ 无事件；未发生或尚未写入日志）。";
    if (input.isJsonOutput) {
      printJson({ status: "ok", isPresent: false, revision: null, incidents: [], notice: text });
    } else {
      process.stdout.write(text + "\n");
    }
    return EXIT_CODES.SUCCESS;
  }

  const incidents = outcome.record.snapshot.incidents;
  if (input.isJsonOutput) {
    printJson({
      status: "ok",
      isPresent: true,
      revision: outcome.record.revision,
      updatedAtIso: outcome.record.updatedAtIso,
      incidents,
      notice: "只读：不恢复、不投递、不调模型。",
    });
    return EXIT_CODES.SUCCESS;
  }

  if (incidents.length === 0) {
    process.stdout.write(
      "事故日志为空（revision " + String(outcome.record.revision) + "；空 ≠ 无事件）。\n",
    );
    return EXIT_CODES.SUCCESS;
  }
  for (const incident of incidents) {
    process.stdout.write(
      [
        incident.incidentIdentifier,
        incident.kind,
        incident.severity,
        incident.state,
        "owner=" + (incident.ownerAgentInstanceId ?? "none"),
        "merged=" + String(incident.mergedEventCount),
      ].join(" · ") + "\n",
    );
  }
  return EXIT_CODES.SUCCESS;
}
