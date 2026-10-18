/**
 * RELOCATE-01：**只读控制面**（2026-10-18 第 19 轮）。
 *
 * 把"读登记 → 冷启动分类"接成一个可被门面/CLI 调用的入口。
 * **本入口只读**：不写盘、不执行任务、不启动模型、不修改任务状态。
 */
import {
  classifyProjectRelocation,
  type ProjectRelocationOutcome,
} from "./project-relocation-classification.js";
import type { ProjectLocationRegistrationStore } from "./project-location-registration-store.js";

/** 冷启动询问所需的外部观测（由控制面提供，不由此类自行读取项目目录）。 */
export interface ProjectRelocationQuery {
  readonly projectIdentifier: string;
  readonly currentRootPath: string;
  readonly isRegisteredRootAccessible: boolean;
  readonly observedProjectIdentifierAtCurrentRoot: string | null;
  readonly candidateIdentifiersWithSameIdentity?: readonly string[];
}

/** 查询结果：分类结论 + 读取结论（便于界面如实说明"登记坏了/旧格式"）。 */
export interface ProjectRelocationDescription {
  readonly registrationReadKind: "absent" | "invalid" | "legacy" | "valid";
  readonly outcome: ProjectRelocationOutcome;
}

/** 只读控制面。 */
export class ProjectRelocationController {
  private readonly store: ProjectLocationRegistrationStore;

  constructor(options: { readonly store: ProjectLocationRegistrationStore }) {
    this.store = options.store;
  }

  /**
   * 描述某项目的冷启动状态。**只读**：`read` 不会创建目录或文件。
   */
  async describeProjectRelocation(
    query: ProjectRelocationQuery,
  ): Promise<ProjectRelocationDescription> {
    const readOutcome = await this.store.read(query.projectIdentifier);

    if (readOutcome.kind === "absent") {
      return {
        registrationReadKind: "absent",
        outcome: classifyProjectRelocation({
          registeredProjectIdentifier: null,
          registeredRootPath: null,
          currentRootPath: query.currentRootPath,
          isRegisteredRootAccessible: false,
          observedProjectIdentifierAtCurrentRoot:
            query.observedProjectIdentifierAtCurrentRoot,
          candidateIdentifiersWithSameIdentity: [],
          isRegistrationCorrupted: false,
        }),
      };
    }

    if (readOutcome.kind === "invalid") {
      return {
        registrationReadKind: "invalid",
        outcome: classifyProjectRelocation({
          registeredProjectIdentifier: null,
          registeredRootPath: null,
          currentRootPath: query.currentRootPath,
          isRegisteredRootAccessible: query.isRegisteredRootAccessible,
          observedProjectIdentifierAtCurrentRoot:
            query.observedProjectIdentifierAtCurrentRoot,
          candidateIdentifiersWithSameIdentity: [],
          isRegistrationCorrupted: true,
        }),
      };
    }

    const registeredProjectIdentifier =
      readOutcome.kind === "valid" ? readOutcome.registration.projectIdentifier : null;
    const registeredRootPath =
      readOutcome.kind === "valid" ? readOutcome.registration.rootPath : null;

    return {
      registrationReadKind: readOutcome.kind,
      outcome: classifyProjectRelocation({
        registeredProjectIdentifier,
        registeredRootPath,
        currentRootPath: query.currentRootPath,
        isRegisteredRootAccessible: query.isRegisteredRootAccessible,
        observedProjectIdentifierAtCurrentRoot: query.observedProjectIdentifierAtCurrentRoot,
        candidateIdentifiersWithSameIdentity: query.candidateIdentifiersWithSameIdentity ?? [],
        /**
         * 2026-10-18 第 22 轮：**旧格式登记（文件存在但缺 schemaVersion）**
         * 不能被当作"未登记"（那会让用户以为项目从未登记过）。
         * 这里复用"登记不可用"的语义 ⇒ 分类为 `identity-missing`，
         * `requiredUserAction` 为「走旧格式关联/恢复流程」，与卡内 §2 最后一行一致。
         */
        isRegistrationCorrupted: readOutcome.kind === "legacy",
      }),
    };
  }
}
