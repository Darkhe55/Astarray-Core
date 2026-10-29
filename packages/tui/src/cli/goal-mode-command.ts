/**
 * F 阶段 R31（2026-10-29）：`goal-mode status` —— 目标模式的**只读** CLI 视图。
 *
 * 只读纪律：不改契约、不绑定 mission、不激活、不写任何文件。
 * 只做三件事：
 * 1. 读契约存储（`<state>/goal-mode/contracts/`）；
 * 2. 读 mission 绑定（`<state>/goal-mode/mission-bindings.json`）；
 * 3. 用 `GoalGateCache.hydrate()` **只读重算**一次，报告"能还原几个门禁 / 为什么跳过"。
 *
 * **本命令不提供任何写入口**：创建契约、绑定 mission、激活目标模式都只能由宿主代码调用。
 */
import { GoalContractStore } from "../../../core/src/orchestration/goal-contract-store.js";
import { GoalMissionBindingStore } from "../../../core/src/orchestration/goal-mission-binding-store.js";
import { GoalModeStateStore } from "../../../core/src/orchestration/goal-mode-store.js";
import { GoalGateCache } from "../../../core/src/orchestration/goal-gate-cache.js";
import { GoalDispatchVerdictJournal } from "../../../core/src/orchestration/goal-dispatch-verdict-journal.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface GoalModeStatusCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
}

export async function executeGoalModeStatusCommand(
  input: GoalModeStatusCommandInput,
): Promise<number> {
  const contractStore = new GoalContractStore({ baseDirectory: input.stateDirectory });
  const bindingStore = new GoalMissionBindingStore({
    baseDirectory: input.stateDirectory,
  });
  const stateStore = new GoalModeStateStore({ baseDirectory: input.stateDirectory });
  const gateCache = new GoalGateCache({
    bindingStore,
    contractStore,
    stateStore,
  });
  let contracts: Awaited<ReturnType<GoalContractStore["list"]>>;
  let bindings: Awaited<ReturnType<GoalMissionBindingStore["list"]>>;
  let hydration: Awaited<ReturnType<GoalGateCache["hydrate"]>>;
  try {
    [contracts, bindings, hydration] = await Promise.all([
      contractStore.list(),
      bindingStore.list(),
      gateCache.hydrate(),
    ]);
  } catch (error) {
    if (input.isJsonOutput) {
      printJson({ status: "failed", reason: (error as Error).message });
    } else {
      process.stdout.write(`读取目标模式状态失败: ${(error as Error).message}\n`);
    }
    return EXIT_CODES.USAGE_ERROR;
  }

  /** R36：统计已关闭的目标（关闭后不再还原门禁，但契约/状态仍在）。 */
  const closedGoalIdentifiers: string[] = [];
  for (const contract of contracts) {
    const state = await stateStore.read(contract.goalIdentifier).catch(() => null);
    if (state !== null && state.isExperimentClosed) {
      closedGoalIdentifiers.push(contract.goalIdentifier);
    }
  }
  const skippedByReason = new Map<string, number>();
  for (const issue of hydration.issues) {
    skippedByReason.set(issue.reason, (skippedByReason.get(issue.reason) ?? 0) + 1);
  }
  const blockedMissionCount = hydration.issues.length;

  if (input.isJsonOutput) {
    printJson({
      status: "read-only",
      contractCount: contracts.length,
      bindingCount: bindings.length,
      restoredGateCount: hydration.restoredCount,
      skippedGateCount: blockedMissionCount,
      skippedByReason: Object.fromEntries(skippedByReason),
      skippedIssues: hydration.issues,
      closedGoalCount: closedGoalIdentifiers.length,
      closedGoalIdentifiers,
      notes: [
        "本命令只读：不创建契约、不绑定 mission、不激活目标模式。",
        "激活状态是运行时内存状态，CLI 无法得知；未激活时门禁解析器恒为 null。",
        "强制模式仍由 isGoalModeEnforcementEnabled 控制（缺省关，只观察）。",
      ],
    });
    return EXIT_CODES.SUCCESS;
  }

  process.stdout.write("===== 目标模式状态（只读）=====\n");
  process.stdout.write(`契约数量: ${String(contracts.length)}\n`);
  process.stdout.write(`mission 绑定数量: ${String(bindings.length)}\n`);
  process.stdout.write(
    `可还原门禁: ${String(hydration.restoredCount)} / 跳过: ${String(blockedMissionCount)}\n`,
  );
  for (const [reason, count] of skippedByReason) {
    process.stdout.write(`  - ${reason}: ${String(count)}\n`);
  }
  process.stdout.write(
    `已关闭实验的目标: ${String(closedGoalIdentifiers.length)}` +
      (closedGoalIdentifiers.length === 0
        ? "\n"
        : `（${closedGoalIdentifiers.join(", ")}；关闭后不再还原门禁）\n`),
  );
  for (const binding of bindings) {
    process.stdout.write(
      `  ${binding.missionIdentifier} → ${binding.goalIdentifier}（绑定于 ${binding.boundAtIso}）\n`,
    );
  }
  process.stdout.write(
    "注意: 本命令只读；激活状态属运行时内存，CLI 无法得知（未激活时解析器恒为 null）。\n",
  );
  process.stdout.write(
    "注意: 强制模式仍缺省关（isGoalModeEnforcementEnabled），当前只观察不阻断。\n",
  );
  return EXIT_CODES.SUCCESS;
}

export interface GoalModeVerdictsCommandInput {
  readonly stateDirectory: string;
  readonly recentCount: number;
  readonly isJsonOutput: boolean;
}

/** R35：`goal-mode verdicts` —— 只读列出最近的派发判定记录（有界，不含正文）。 */
export async function executeGoalModeVerdictsCommand(
  input: GoalModeVerdictsCommandInput,
): Promise<number> {
  const journal = new GoalDispatchVerdictJournal({
    baseDirectory: input.stateDirectory,
  });
  let document: Awaited<ReturnType<GoalDispatchVerdictJournal["read"]>>;
  try {
    document = await journal.read();
  } catch (error) {
    if (input.isJsonOutput) {
      printJson({ status: "failed", reason: (error as Error).message });
    } else {
      process.stdout.write(`读取判定记录失败: ${(error as Error).message}\n`);
    }
    return EXIT_CODES.USAGE_ERROR;
  }
  const limit = Math.max(1, Math.trunc(input.recentCount));
  const recent = document.records.slice(-limit);
  if (input.isJsonOutput) {
    printJson({
      status: "read-only",
      totalRecordedCount: document.totalRecordedCount,
      droppedRecordCount: document.droppedRecordCount,
      returnedCount: recent.length,
      records: recent,
      note: "只读：判定记录有界（200 条），不含正文；isEnforced=false 表示仅观察未阻断。",
    });
    return EXIT_CODES.SUCCESS;
  }
  process.stdout.write("===== 目标门禁判定记录（只读）=====\n");
  process.stdout.write(
    `累计记录: ${String(document.totalRecordedCount)} 条；被截断丢弃: ${String(document.droppedRecordCount)} 条；本次显示最近 ${String(recent.length)} 条\n`,
  );
  for (const record of recent) {
    process.stdout.write(
      `- ${record.observedAtIso} mission=${record.missionIdentifier} allowed=${String(record.isAllowed)} ` +
        `enforced=${String(record.isEnforced)} reason=${record.reasonCode ?? "-"}\n`,
    );
  }
  if (recent.length === 0) {
    process.stdout.write("（还没有任何判定记录：未激活/未绑定/未观察）\n");
  }
  process.stdout.write(
    "注意: isEnforced=false 表示只观察未阻断（强制模式缺省关）。\n",
  );
  return EXIT_CODES.SUCCESS;
}
