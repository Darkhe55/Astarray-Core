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
import { AstarrayApplicationFacade } from "../../../core/src/public-sdk.js";

export interface GoalModeStatusCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
  /** R71（2026-10-30）：给了就只看该目标的**状态视图**（等价于宿主 describeGoalStatus）。 */
  readonly goalIdentifier?: string;
}

export async function executeGoalModeStatusCommand(
  input: GoalModeStatusCommandInput,
): Promise<number> {
  /**
   * R71：`--goal <id>` ⇒ 只输出该目标的 `describeStatus` 视图（唯一事实来源；无状态 ⇒ 退出码 2）。
   */
  if (input.goalIdentifier !== undefined) {
    const goalStateStore = new GoalModeStateStore({
      baseDirectory: input.stateDirectory,
    });
    const statusView = await goalStateStore
      .describeStatus(input.goalIdentifier)
      .catch(() => null);
    if (statusView === null) {
      if (input.isJsonOutput) {
        printJson({
          status: "goal-not-found",
          goalIdentifier: input.goalIdentifier,
          note: "没有该目标的状态：尚未创建契约/状态，或已归档。",
        });
      } else {
        process.stdout.write(
          `没有目标 ${input.goalIdentifier} 的状态（尚未创建或已归档）。\n`,
        );
      }
      return EXIT_CODES.USAGE_ERROR;
    }
    if (input.isJsonOutput) {
      printJson({ status: "goal-status", goalStatus: statusView });
      return EXIT_CODES.SUCCESS;
    }
    process.stdout.write(`===== 目标状态（${statusView.goalIdentifier}）=====\n`);
    process.stdout.write(`契约 revision: ${String(statusView.contractRevision)}\n`);
    process.stdout.write(
      `实验已关闭: ${statusView.isExperimentClosed ? "是" : "否"}；已暂停: ${statusView.isPaused ? "是" : "否"}\n`,
    );
    process.stdout.write(`暂停原因: ${statusView.pauseReason ?? "（无）"}\n`);
    process.stdout.write(`需要重新规划: ${statusView.requiresReplanning ? "是" : "否"}\n`);
    process.stdout.write(
      `最近 V: ${statusView.lastPotentialValue === null ? "未知" : String(statusView.lastPotentialValue)}；依据条数: ${String(statusView.requirementBasisCount)}\n`,
    );
    process.stdout.write(
      `证据缺口: ${String(statusView.evidenceGapCount)} 条；累计工具调用: ${String(statusView.consumedToolCalls)}\n`,
    );
    process.stdout.write(`下一检查点: ${statusView.nextCheckpoint}\n`);
    process.stdout.write(
      `稳定性保证: ${statusView.stabilityGuarantee}（本命令不提供、不宣称任何稳定性保证）\n`,
    );
    process.stdout.write(`更新时间: ${statusView.updatedAtIso}\n`);
    return EXIT_CODES.SUCCESS;
  }
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
  /** R53（2026-10-29）：给了就**只读导出**全部保留记录为 JSONL（每行一条）。 */
  readonly exportPath?: string;
  /** R63（2026-10-30）：导出时**一并包含已归档记录**（`dispatch-verdicts-archive.jsonl`）。 */
  readonly includeArchive?: boolean;
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
  /**
   * R53（2026-10-29）：`--export` ⇒ 把**存储中保留的全部记录**写成 JSONL（不含正文）。
   *
   * 只读源存储；写入失败 ⇒ 退出码 2（不谎报导出成功）。导出不改默认视图与保留策略。
   */
  if (input.exportPath !== undefined) {
    const exportPath = input.exportPath.trim();
    if (exportPath === "") {
      process.stderr.write("astarray: --export 需要非空路径\n");
      return EXIT_CODES.USAGE_ERROR;
    }
    try {
      const archivedLines: string[] = [];
      if (input.includeArchive === true) {
        try {
          const { readFile } = await import("node:fs/promises");
          const archivePath = `${input.stateDirectory}/goal-mode/dispatch-verdicts-archive.jsonl`;
          const archiveText = await readFile(archivePath, "utf8");
          archivedLines.push(
            ...archiveText.split(/\r?\n/).filter((line) => line.trim() !== ""),
          );
        } catch {
          /** 没有归档文件 ⇒ 视为空（不报错）。 */
        }
      }
      const jsonLines = [
        ...archivedLines,
        ...document.records.map((record) => JSON.stringify(record)),
      ].join("\n");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(exportPath, jsonLines === "" ? "" : `${jsonLines}\n`, "utf8");
    } catch (error) {
      process.stderr.write(`astarray: 导出判定记录失败: ${(error as Error).message}\n`);
      return EXIT_CODES.USAGE_ERROR;
    }
    if (input.isJsonOutput) {
      printJson({
        status: "exported",
        exportPath,
        exportedCount: document.records.length,
        droppedRecordCount: document.droppedRecordCount,
        note: "JSONL 每行一条判定；不含正文；导出不改变保留策略。",
      });
    } else {
      process.stdout.write(
        `已导出 ${String(document.records.length)} 条判定到 ${exportPath}（JSONL；丢弃 ${String(document.droppedRecordCount)} 条历史不可恢复）\n`,
      );
    }
    return EXIT_CODES.SUCCESS;
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
/**
 * R81（2026-10-31）：`goal-mode propose` —— **模型/宿主提交提案**（不落契约）。
 *
 * 提案只是候选：必须由用户 `confirm` 后才生成契约。`sourceRequestReference` 必须显式给出
 * （由 harness 注入），模型不能自填"用户说过"。
 */
export interface GoalModeProposeCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
  readonly draftJson: string;
  readonly sourceRequestReference: string;
  readonly expiresInSeconds?: number;
}

export async function executeGoalModeProposeCommand(
  input: GoalModeProposeCommandInput,
): Promise<number> {
  let draft: unknown;
  try {
    draft = JSON.parse(input.draftJson);
  } catch (error) {
    process.stderr.write(`提案 JSON 无法解析: ${(error as Error).message}\n`);
    return EXIT_CODES.USAGE_ERROR;
  }
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: input.stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
  try {
    const result = await application.proposeGoalContract({
      draft: draft as never,
      sourceRequestReference: input.sourceRequestReference,
      ...(input.expiresInSeconds === undefined
        ? {}
        : { expiresInSeconds: input.expiresInSeconds }),
    });
    if (input.isJsonOutput) {
      printJson({ status: "goal-proposal-created", ...result });
    } else {
      process.stdout.write(`提案已创建: ${result.proposalIdentifier}\n`);
      process.stdout.write(`过期时间: ${result.expiresAtIso}\n`);
      process.stdout.write("确认后才生成目标契约：goal-mode confirm <proposal-id> --goal <id> --owner <user> --yes\n");
    }
    return EXIT_CODES.SUCCESS;
  } finally {
    await application.shutdown();
  }
}

/**
 * R81：`goal-mode confirm` —— **用户显式确认**提案，生成 revision 1 契约。
 *
 * 必须 `--yes`；CLI 以"用户显式请求 + 已认证 + 显式开启"激活目标模式（模型不能代替）。
 */
export interface GoalModeConfirmCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
  readonly proposalIdentifier: string;
  readonly goalIdentifier: string;
  readonly ownerIdentifier: string;
  readonly isConfirmed: boolean;
}

export async function executeGoalModeConfirmCommand(
  input: GoalModeConfirmCommandInput,
): Promise<number> {
  if (input.isConfirmed !== true) {
    process.stderr.write("拒绝确认：必须显式传 --yes（模型/脚本不得代替用户确认）。\n");
    return EXIT_CODES.USAGE_ERROR;
  }
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: input.stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
  try {
    const activation = application.activateGoalMode({
      isExplicitUserRequest: true,
      isAuthenticatedUser: true,
      isExplicitlyEnabled: true,
      requestedBy: "user",
    });
    if (!activation.isActive) {
      process.stderr.write(`目标模式未激活: ${activation.reason}\n`);
      return EXIT_CODES.USAGE_ERROR;
    }
    const result = await application.confirmGoalContract({
      proposalIdentifier: input.proposalIdentifier,
      goalIdentifier: input.goalIdentifier,
      ownerIdentifier: input.ownerIdentifier,
      activation: {
        isExplicitUserRequest: true,
        isAuthenticatedUser: true,
        isExplicitlyEnabled: true,
        requestedBy: "user",
      },
      isUserConfirmation: true,
    });
    if (input.isJsonOutput) {
      printJson({ status: "goal-contract-created", ...result });
    } else {
      process.stdout.write(`目标契约已创建: ${result.goalIdentifier}（revision ${String(result.revision)}）\n`);
    }
    return EXIT_CODES.SUCCESS;
  } finally {
    await application.shutdown();
  }
}

/** R81：`goal-mode bind` —— 把一个**已存在**的 mission 绑定到目标（事后绑定；仅用于修复/补登记）。 */
export interface GoalModeBindCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
  readonly missionIdentifier: string;
  readonly goalIdentifier: string;
}

export async function executeGoalModeBindCommand(
  input: GoalModeBindCommandInput,
): Promise<number> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: input.stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
  try {
    const result = await application.bindMissionToGoal({
      missionIdentifier: input.missionIdentifier,
      goalIdentifier: input.goalIdentifier,
    });
    if (input.isJsonOutput) {
      printJson({ status: "goal-bound", missionIdentifier: input.missionIdentifier, ...result });
    } else {
      process.stdout.write(`mission ${input.missionIdentifier} 已绑定到目标 ${result.goalIdentifier}\n`);
      process.stdout.write("注意：事后绑定不会改变本次派发的门禁结论（门禁在启动时评估）。\n");
    }
    return EXIT_CODES.SUCCESS;
  } finally {
    await application.shutdown();
  }
}

/** R81：`goal-mode map` —— 把某条要求映射到任务节点（K2；不改契约 revision）。 */
export interface GoalModeMapCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
  readonly goalIdentifier: string;
  readonly requirementIdentifier: string;
  readonly taskNodeIdentifiers: readonly string[];
}

export async function executeGoalModeMapCommand(
  input: GoalModeMapCommandInput,
): Promise<number> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: input.stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
  try {
    const result = await application.bindRequirementTaskMapping({
      goalIdentifier: input.goalIdentifier,
      requirementIdentifier: input.requirementIdentifier,
      taskNodeIdentifiers: input.taskNodeIdentifiers,
    });
    if (input.isJsonOutput) {
      printJson({ status: "goal-requirement-mapped", ...result });
    } else {
      process.stdout.write(
        `已映射 ${input.requirementIdentifier} → ${input.taskNodeIdentifiers.join(", ")}（共 ${String(result.mappingCount)} 条）\n`,
      );
    }
    return EXIT_CODES.SUCCESS;
  } finally {
    await application.shutdown();
  }
}

/** R83：`goal-mode invalidate` —— 标记证据失效（K5 内核入口的 CLI；暂停 + 需重新规划）。 */
export interface GoalModeInvalidateCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
  readonly goalIdentifier: string;
  readonly requirementIdentifiers: readonly string[];
  readonly reason: string;
}

export async function executeGoalModeInvalidateCommand(
  input: GoalModeInvalidateCommandInput,
): Promise<number> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: input.stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
  try {
    const result = await application.invalidateGoalEvidence({
      goalIdentifier: input.goalIdentifier,
      requirementIdentifiers: input.requirementIdentifiers,
      reason: input.reason,
    });
    if (input.isJsonOutput) {
      printJson({ status: "goal-evidence-invalidated", ...result });
    } else {
      process.stdout.write(`已标记证据失效: ${result.invalidatedRequirementIdentifiers.join(", ")}\n`);
      process.stdout.write(`失效后 V: ${result.potentialValueAfterInvalidation === null ? "未知" : String(result.potentialValueAfterInvalidation)}\n`);
      process.stdout.write("目标已暂停并标记需要重新规划（--goal-enforce 下会阻断派发/停止调度）。\n");
    }
    return EXIT_CODES.SUCCESS;
  } finally {
    await application.shutdown();
  }
}
