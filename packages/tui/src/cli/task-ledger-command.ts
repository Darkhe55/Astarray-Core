/**
 * `task-ledger status`：两套记账的**只读** CLI 入口（清单第 ① 项出口，2026-10-28）。
 *
 * 只读纪律：不改任务链、不改序列、不派发、不调模型、不写任何文件；
 * 只读两个已有存储与差异历史 journal。
 *
 * 输入全部显式：`--mission` / `--sequence` / `--owner`。
 * 缺任一项 ⇒ 只展示差异历史，并**如实说明**为什么没有对照结果（不猜测 mission↔序列映射）。
 */
import { AgentTaskSequenceStore } from "../../../core/src/orchestration/agent-task-sequence-store.js";
import { MissionManager } from "../../../core/src/orchestration/mission-manager.js";
import { TaskLedgerBridge } from "../../../core/src/orchestration/task-ledger-bridge.js";
import { TaskLedgerDivergenceJournal } from "../../../core/src/orchestration/task-ledger-divergence-journal.js";
import { MissionSequenceBindingStore } from "../../../core/src/orchestration/mission-sequence-binding-store.js";
import { TaskSequenceStatusController } from "../../../core/src/orchestration/task-sequence-controllers.js";
import { TaskStore } from "../../../core/src/infra/task-store.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface TaskLedgerStatusCommandInput {
  readonly stateDirectory: string;
  readonly missionIdentifier?: string;
  readonly sequenceIdentifier?: string;
  readonly ownerAgentInstanceIdentifier?: string;
  readonly recentCount?: number;
  readonly isJsonOutput: boolean;
}

export async function executeTaskLedgerStatusCommand(
  input: TaskLedgerStatusCommandInput,
): Promise<number> {
  const recentCount = input.recentCount ?? 10;
  const journal = new TaskLedgerDivergenceJournal({
    baseDirectory: input.stateDirectory,
  });
  const recentDivergences = await journal.readRecent(recentCount);
  /**
   * R21（2026-10-29）：**优先用持久索引补全** sequence/owner（缺省才要求手填）。
   * 索引缺失 ⇒ 仍如实报"缺参数"，**不猜**。
   */
  let resolvedSequenceIdentifier = input.sequenceIdentifier;
  let resolvedOwnerAgentInstanceIdentifier = input.ownerAgentInstanceIdentifier;
  if (
    input.missionIdentifier !== undefined &&
    (resolvedSequenceIdentifier === undefined ||
      resolvedOwnerAgentInstanceIdentifier === undefined)
  ) {
    const bindingStore = new MissionSequenceBindingStore({
      baseDirectory: input.stateDirectory,
    });
    const binding = await bindingStore
      .readForMission(input.missionIdentifier)
      .catch(() => null);
    if (binding !== null) {
      resolvedSequenceIdentifier ??= binding.sequenceIdentifier;
      resolvedOwnerAgentInstanceIdentifier ??= binding.ownerAgentInstanceIdentifier;
    }
  }
  const missingInputs = [
    input.missionIdentifier === undefined ? "--mission" : null,
    resolvedSequenceIdentifier === undefined ? "--sequence" : null,
    resolvedOwnerAgentInstanceIdentifier === undefined ? "--owner" : null,
  ].filter((missing): missing is string => missing !== null);

  if (missingInputs.length > 0) {
    if (input.isJsonOutput) {
      printJson({
        status: "missing-inputs",
        missingInputs,
        divergenceCount: recentDivergences.length,
        recentDivergences,
        note: "对账需要 --mission/--sequence/--owner；本命令不猜测 mission 与序列的映射关系。",
      });
    } else {
      process.stdout.write(
        `对账需要 --mission / --sequence / --owner（缺少: ${missingInputs.join(", ")}）。\n`,
      );
      process.stdout.write(
        `差异历史（最近 ${String(recentDivergences.length)} 条）:\n`,
      );
      for (const entry of recentDivergences) {
        process.stdout.write(
          `- ${entry.recordedAtIso} ${entry.missionIdentifier} ` +
            `onlySequence=${String(entry.tasksOnlyInSequence.length)} ` +
            `onlyMission=${String(entry.tasksOnlyInMission.length)} ` +
            `mismatch=${String(entry.statusMismatchCount)} (${entry.trigger})\n`,
        );
      }
    }
    return EXIT_CODES.SUCCESS;
  }

  const taskStore = new TaskStore({ baseDirectory: input.stateDirectory });
  const missionManager = new MissionManager(taskStore, input.stateDirectory);
  const sequenceStore = new AgentTaskSequenceStore({
    baseDirectory: input.stateDirectory,
  });
  const statusController = new TaskSequenceStatusController(sequenceStore);
  const bridge = new TaskLedgerBridge({
    sequenceLedger: {
      getSnapshot: (snapshotInput) => statusController.getSnapshot(snapshotInput),
    },
    missionTaskChain: {
      getMissionStatus: (missionIdentifier) =>
        missionManager.getMissionStatus(missionIdentifier),
    },
  });

  let report: Awaited<ReturnType<TaskLedgerBridge["inspectAlignment"]>>;
  try {
    report = await bridge.inspectAlignment({
      missionIdentifier: input.missionIdentifier as string,
      sequenceId: resolvedSequenceIdentifier as string,
      ownerAgentInstanceId: resolvedOwnerAgentInstanceIdentifier as string,
      viewer: { sourceKind: "user", actorId: "cli" },
    });
  } catch (error) {
    if (input.isJsonOutput) {
      printJson({
        status: "failed",
        reason: (error as Error).message,
        divergenceCount: recentDivergences.length,
        recentDivergences,
      });
    } else {
      process.stdout.write(`对账失败: ${(error as Error).message}\n`);
    }
    return EXIT_CODES.USAGE_ERROR;
  }

  if (input.isJsonOutput) {
    printJson({
      status: report.divergences.length === 0 ? "consistent" : "divergent",
      report,
      recentDivergences,
    });
    return EXIT_CODES.SUCCESS;
  }
  process.stdout.write(
    `mission ${report.missionIdentifier} ↔ 序列 ${report.sequenceId}（revision ${String(report.sequenceRevision)}）\n`,
  );
  process.stdout.write(
    `任务数: 序列 ${String(report.sequenceTaskIdentifiers.length)} / mission ${String(report.missionTaskIdentifiers.length)}\n`,
  );
  process.stdout.write(`ready: ${report.readyTaskIdentifiers.join(", ") || "（无）"}\n`);
  process.stdout.write(
    `只在序列: ${report.tasksOnlyInSequence.join(", ") || "（无）"}\n`,
  );
  process.stdout.write(
    `只在 mission: ${report.tasksOnlyInMission.join(", ") || "（无）"}\n`,
  );
  process.stdout.write(
    `状态不一致: ${
      report.statusMismatches.length === 0
        ? "（无）"
        : report.statusMismatches
            .map(
              (mismatch) =>
                `${mismatch.taskIdentifier}(序列=${mismatch.sequenceStatus}, mission=${mismatch.missionStatus})`,
            )
            .join(", ")
    }\n`,
  );
  process.stdout.write(
    `差异历史（最近 ${String(recentDivergences.length)} 条）: ${
      recentDivergences.length === 0 ? "（无）" : ""
    }\n`,
  );
  for (const entry of recentDivergences) {
    process.stdout.write(
      `- ${entry.recordedAtIso} onlySequence=${String(entry.tasksOnlyInSequence.length)} ` +
        `onlyMission=${String(entry.tasksOnlyInMission.length)} ` +
        `mismatch=${String(entry.statusMismatchCount)} (${entry.trigger})\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}
