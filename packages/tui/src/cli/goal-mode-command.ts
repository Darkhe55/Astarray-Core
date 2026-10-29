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
