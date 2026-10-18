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
