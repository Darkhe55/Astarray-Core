/**
 * `project status`：冷启动重定位状态的**只读** CLI 入口（RELOCATE-01-04，2026-10-18）。
 *
 * 产品文案（命令名 `project status`）经用户 2026-10-18 确认（选项 A）。
 *
 * 只读：不写登记、不执行任务、不启动模型、不修改任务状态。
 */
import { existsSync } from "node:fs";

import {
  ProjectLocationRegistrationStore,
  ProjectRelocationController,
} from "../../../core/src/public-sdk.js";
import { EXIT_CODES, failWith, printJson } from "./json-output.js";

/** 命令输入。 */
export interface ProjectStatusCommandInput {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  /** 用户当前选择的项目根。 */
  readonly currentRootPath: string;
  /**
   * 在当前根实际观测到的项目标识。
   *
   * **为什么是参数**：项目内标识文件的形态由项目自身定义，CLI 不擅自假设文件名；
   * 无法提供时保持缺省 ⇒ 判定为 `identity-missing`（fail-closed），而不是"乐观放行"。
   */
  readonly observedProjectIdentifier: string | null;
  readonly isJsonOutput: boolean;
}

/** 执行 `project status`。返回进程退出码。 */
export async function executeProjectStatusCommand(
  input: ProjectStatusCommandInput,
): Promise<number> {
  const controller = new ProjectRelocationController({
    store: new ProjectLocationRegistrationStore({ baseDirectory: input.stateDirectory }),
  });

  let description;
  try {
    description = await controller.describeProjectRelocation({
      projectIdentifier: input.projectIdentifier,
      currentRootPath: input.currentRootPath,
      isRegisteredRootAccessible: existsSync(input.currentRootPath),
      observedProjectIdentifierAtCurrentRoot: input.observedProjectIdentifier,
      candidateIdentifiersWithSameIdentity: [],
    });
  } catch (error) {
    failWith(
      new Error(
        `读取项目登记失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  const payload = {
    projectIdentifier: input.projectIdentifier,
    currentRootPath: input.currentRootPath,
    registrationReadKind: description.registrationReadKind,
    classification: description.outcome.classification,
    isHistoryLoadable: description.outcome.isHistoryLoadable,
    isExecutionAllowed: description.outcome.isExecutionAllowed,
    requiredUserAction: description.outcome.requiredUserAction,
    reason: description.outcome.reason,
  };

  if (input.isJsonOutput) {
    printJson(payload);
    return EXIT_CODES.SUCCESS;
  }

  process.stdout.write(
    [
      `项目：${payload.projectIdentifier}`,
      `当前根：${payload.currentRootPath}`,
      `登记：${payload.registrationReadKind}`,
      `分类：${payload.classification}`,
      `可加载历史：${payload.isHistoryLoadable ? "是" : "否"}`,
      `可执行任务：${payload.isExecutionAllowed ? "是" : "否"}`,
      `需要你做的：${payload.requiredUserAction}`,
      `说明：${payload.reason}`,
      "",
    ].join("\n"),
  );
  return EXIT_CODES.SUCCESS;
}

/**
 * `project reconcile`：重定位对账的**只读**入口（RELOCATE-01-03，2026-10-19 R34）。
 *
 * 用户 2026-10-19 决策（按推荐）：命令名 = `astarray project reconcile`；
 * 只读可自动恢复、**含写/外部副作用必须人工确认**、不满足即 blocked、不重放已完成操作。
 *
 * 为什么要有这个命令：判定层（`reconcileProjectRelocation`）已经存在，但**用户无法触达**。
 * 这里把它接到公开入口：输入是**显式 JSON**（不猜历史库），输出是"能否自动恢复 / 需要你做什么"。
 *
 * 退出码：
 * - `0`：可以继续（只读自动恢复）；
 * - `1`：`blocked`，**或**已解析但含写/外部副作用需人工确认（非零更安全，避免脚本误判已恢复）；
 * - `2`：用法/输入错误（文件缺失、JSON 非法、字段非法）。
 */
export interface ProjectReconcileCommandInput {
  readonly inputFilePath: string;
  readonly isJsonOutput: boolean;
}

interface RelocationReconcileFileShape {
  projectIdentifier?: unknown;
  projectStatus?: unknown;
  locationMappings?: unknown;
  declaredStructuredResourceKinds?: unknown;
  references?: unknown;
  pendingOperations?: unknown;
  hasWriteOrExternalSideEffects?: unknown;
}

const PROJECT_RELOCATION_STATUSES = new Set(["in-progress", "unresolved", "completed"]);

/** 执行 `project reconcile`。返回进程退出码。 */
export async function executeProjectReconcileCommand(
  input: ProjectReconcileCommandInput,
): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  let rawText: string;
  try {
    rawText = await readFile(input.inputFilePath, "utf8");
  } catch {
    failWith(new Error(`无法读取对账输入文件：${input.inputFilePath}`), EXIT_CODES.USAGE_ERROR);
  }

  let parsed: RelocationReconcileFileShape;
  try {
    parsed = JSON.parse(rawText) as RelocationReconcileFileShape;
  } catch {
    failWith(new Error("对账输入不是合法 JSON"), EXIT_CODES.USAGE_ERROR);
  }

  if (
    typeof parsed.projectIdentifier !== "string" ||
    parsed.projectIdentifier.trim() === ""
  ) {
    failWith(new Error("对账输入缺少 projectIdentifier"), EXIT_CODES.USAGE_ERROR);
  }
  if (
    typeof parsed.projectStatus !== "string" ||
    !PROJECT_RELOCATION_STATUSES.has(parsed.projectStatus)
  ) {
    failWith(
      new Error("对账输入的 projectStatus 必须是 in-progress / unresolved / completed"),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  if (
    !Array.isArray(parsed.locationMappings) ||
    !Array.isArray(parsed.declaredStructuredResourceKinds) ||
    !Array.isArray(parsed.references) ||
    !Array.isArray(parsed.pendingOperations) ||
    typeof parsed.hasWriteOrExternalSideEffects !== "boolean"
  ) {
    failWith(
      new Error(
        "对账输入需包含数组 locationMappings / declaredStructuredResourceKinds / references / pendingOperations，以及布尔 hasWriteOrExternalSideEffects",
      ),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const { reconcileProjectRelocation } = await import("../../../core/src/public-sdk.js");
  const reconciliation = reconcileProjectRelocation({
    projectIdentifier: parsed.projectIdentifier,
    projectStatus: parsed.projectStatus as "in-progress" | "unresolved" | "completed",
    locationMappings: parsed.locationMappings as never,
    declaredStructuredResourceKinds: parsed.declaredStructuredResourceKinds as string[],
    references: parsed.references as never,
    pendingOperations: parsed.pendingOperations as never,
    hasWriteOrExternalSideEffects: parsed.hasWriteOrExternalSideEffects,
  });

  const payload = {
    projectIdentifier: reconciliation.projectIdentifier,
    kind: reconciliation.kind,
    isAutoResumeAllowed: reconciliation.isAutoResumeAllowed,
    isExecutionAllowed: reconciliation.isExecutionAllowed,
    resolvedReferenceCount: reconciliation.resolvedReferences.length,
    rewrittenReferenceCount: reconciliation.resolvedReferences.filter(
      (reference) => reference.wasRewritten,
    ).length,
    unresolvedReferences: reconciliation.unresolvedReferences.map((reference) => ({
      rejectionCode: reference.rejectionCode,
      reason: reference.reason,
    })),
    pendingOperationDecisions: reconciliation.pendingOperationDecisions,
    requiredUserAction: reconciliation.requiredUserAction,
  };

  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      [
        `项目：${payload.projectIdentifier}`,
        `结论：${payload.kind}`,
        `引用：解析 ${String(payload.resolvedReferenceCount)} 条（其中改写 ${String(payload.rewrittenReferenceCount)}），未解析 ${String(payload.unresolvedReferences.length)} 条`,
        `未决操作：${String(payload.pendingOperationDecisions.length)} 条`,
        `可自动恢复：${payload.isAutoResumeAllowed ? "是" : "否"}`,
        `可执行：${payload.isExecutionAllowed ? "是" : "否"}`,
        `需要你做的：${payload.requiredUserAction}`,
        "",
      ].join("\n"),
    );
    for (const unresolved of payload.unresolvedReferences) {
      process.stdout.write(`  · 未解析（${unresolved.rejectionCode}）：${unresolved.reason}\n`);
    }
  }

  // 只有"可以继续"才返回 0；blocked 与"需人工确认"都返回非 0（不谎报已恢复）
  return reconciliation.isExecutionAllowed ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
}
