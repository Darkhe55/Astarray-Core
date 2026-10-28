/**
 * 任务状态管理（T08/T09）。
 * 管理 mission 概要（.astarray/missions/<missionId>/summary.json）与任务链。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import type { AgentMode, TaskChainDocument } from "../core/types.js";
import { taskChainSchema } from "../core/schemas.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import type { TaskStorePort } from "../core/types.js";

export interface MissionSummary {
  schemaVersion: 1;
  missionId: string;
  mode: AgentMode;
  prompt: string;
  createdAtIso: string;
  status: "running" | "done" | "cancelled" | "blocked";
  /**
   * GUI-02-03（2026-11-08）：该 mission 所属**项目标识**。
   *
   * 卡内要求历史列表能呈现「任务目标／**项目**／时间/最后状态/结果」，
   * 而此前摘要里**没有**项目信息 ⇒ 历史视图无从显示「项目」。
   * 取值来自装配层的 `projectIdentifier`（与 `registeredProjectRoots` 同源）。
   *
   * **可选**是刻意的：历史遗留的 `summary.json` 没有该字段，
   * 读取方必须把它当作「**没有项目信息**」（`null`），**不得伪造**。
   */
  projectIdentifier?: string;
  /**
   * ALIGN-01-01（2026-10-28）：该 mission 所属的**稳定会话**。
   *
   * 与 `missionId` 分工：mission 是"一次执行投影"，会话是跨消息、跨重启
   * 稳定存在的实体（其下挂着固定的主个体）。历史遗留摘要没有该字段 ⇒
   * 读取方必须当作"未知会话"，**不得用 missionId 顶替**。
   */
  conversationIdentifier?: string;
  /**
   * ALIGN-02-01（2026-10-28）：该 mission 所投影的**权威任务序列**标识。
   *
   * mission 是"一次任务组执行"，不是可独立调序的权威待办；真正的权威是
   * 目标次级的版本化偏序集（`sequence-<secondaryAgentInstanceId>`）。
   * 旧摘要没有该字段 ⇒ 读取方按"无序列投影"处理，**不得用 missionId 顶替**。
   */
  taskSequenceIdentifier?: string;
  /** ALIGN-02-01：序列里承载本次用户原始任务的任务标识（`task-<missionId>`）。 */
  originalTaskIdentifier?: string;
  /**
   * ALIGN-02-02（2026-10-28）：本次执行的任务分解来源。
   *
   * - `model`：候选分解通过本地校验；
   * - `single-node-fallback`：有规划器但规划/校验失败，已**降级**为单节点；
   * - `legacy-single-node`：未装配规划器（旧行为），**不是**"已规划"。
   * 旧摘要没有该字段 ⇒ 读取方按"未知来源"处理，不得当作已规划。
   */
  taskPlanningOutcome?: "model" | "single-node-fallback" | "legacy-single-node";
  /** ALIGN-02-02：降级原因（仅 `single-node-fallback` 时有值）。 */
  taskPlanningFallbackReason?: string;
}

export interface MissionStatus {
  missionId: string;
  summary: MissionSummary | null;
  taskChain: TaskChainDocument | null;
}

/** T12-04：只读探针结果（损坏容错，绝不抛错；区分缺失/损坏/正常）。 */
export interface MissionDirectoryProbe {
  missionId: string;
  exists: boolean;
  hasSummary: boolean;
  summaryStatus: MissionSummary["status"] | null;
  summaryCorrupted: boolean;
  hasTaskChain: boolean;
  taskChainCorrupted: boolean;
  pendingTaskCount: number | null;
}

export interface CreateMissionInput {
  missionId: string;
  mode: AgentMode;
  prompt: string;
  taskNodes: TaskChainDocument["tasks"];
  /** GUI-02-03：所属项目标识（可选；缺省则摘要里不写该项目字段）。 */
  projectIdentifier?: string;
  /** ALIGN-01-01：所属稳定会话标识（可选；缺省则摘要里不写该会话字段）。 */
  conversationIdentifier?: string;
  /** ALIGN-02-01：所投影的权威任务序列标识（可选）。 */
  taskSequenceIdentifier?: string;
  /** ALIGN-02-01：序列中承载用户原始任务的任务标识（可选）。 */
  originalTaskIdentifier?: string;
  /** ALIGN-02-02：任务分解来源（可选；缺省 ⇒ 摘要不写，读取方按未知处理）。 */
  taskPlanningOutcome?: "model" | "single-node-fallback" | "legacy-single-node";
  /** ALIGN-02-02：降级原因（可选）。 */
  taskPlanningFallbackReason?: string;
}

export class MissionManager {
  private readonly summaryWriteMutex = new AsyncMutex();

  constructor(
    private readonly taskStore: TaskStorePort,
    private readonly stateDirectory: string,
  ) {}

  private summaryFilePath(missionId: string): string {
    return path.join(
      this.stateDirectory,
      "missions",
      missionId,
      "summary.json",
    );
  }

  async createMission(input: CreateMissionInput): Promise<TaskChainDocument> {
    const document: TaskChainDocument = {
      schemaVersion: 1,
      missionId: input.missionId,
      revision: 1,
      updatedAtIso: new Date().toISOString(),
      tasks: input.taskNodes,
    };
    const parsed = taskChainSchema.safeParse(document);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `任务链非法: ${parsed.error.message}`,
      );
    }
    await this.taskStore.writeTaskChain(parsed.data);
    const summary: MissionSummary = {
      schemaVersion: 1,
      missionId: input.missionId,
      mode: input.mode,
      prompt: input.prompt,
      createdAtIso: new Date().toISOString(),
      status: "running",
      /**
       * GUI-02-03：只在**确有项目标识**时写入该字段（空/空白不写），
       * 避免落盘一个「看着有值其实是空」的项目名。
       */
      ...(typeof input.projectIdentifier === "string" &&
      input.projectIdentifier.trim().length > 0
        ? { projectIdentifier: input.projectIdentifier.trim() }
        : {}),
      /**
       * ALIGN-01-01：同项目字段纪律 —— 只在确有非空会话标识时写入，
       * 绝不拿 missionId 凑一个"看起来像会话"的值。
       */
      ...(typeof input.conversationIdentifier === "string" &&
      input.conversationIdentifier.trim().length > 0
        ? { conversationIdentifier: input.conversationIdentifier.trim() }
        : {}),
      ...(typeof input.taskSequenceIdentifier === "string" &&
      input.taskSequenceIdentifier.trim().length > 0
        ? { taskSequenceIdentifier: input.taskSequenceIdentifier.trim() }
        : {}),
      ...(typeof input.originalTaskIdentifier === "string" &&
      input.originalTaskIdentifier.trim().length > 0
        ? { originalTaskIdentifier: input.originalTaskIdentifier.trim() }
        : {}),
      /** ALIGN-02-02：分解来源必须如实落盘（降级不得伪装成"已规划"）。 */
      ...(input.taskPlanningOutcome === undefined
        ? {}
        : { taskPlanningOutcome: input.taskPlanningOutcome }),
      ...(typeof input.taskPlanningFallbackReason === "string" &&
      input.taskPlanningFallbackReason.trim().length > 0
        ? { taskPlanningFallbackReason: input.taskPlanningFallbackReason.trim() }
        : {}),
    };
    await this.summaryWriteMutex.runExclusive(() =>
      writeAtomicJson(this.summaryFilePath(input.missionId), summary),
    );
    return parsed.data;
  }

  async updateMissionStatus(
    missionId: string,
    status: MissionSummary["status"],
  ): Promise<void> {
    await this.summaryWriteMutex.runExclusive(async () => {
      const summary = await this.readSummary(missionId);
      if (summary === null) {
        return;
      }
      await writeAtomicJson(this.summaryFilePath(missionId), {
        ...summary,
        status,
      });
    });
  }

  async readSummary(missionId: string): Promise<MissionSummary | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const rawContent = await readFile(this.summaryFilePath(missionId), "utf8");
      return JSON.parse(rawContent) as MissionSummary;
    } catch {
      return null;
    }
  }

  async getMissionStatus(missionId: string): Promise<MissionStatus> {
    const summary = await this.readSummary(missionId);
    const taskChain = await this.taskStore.readTaskChain(missionId);
    if (summary === null && taskChain === null) {
      throw new DomainError("mission-not-found", `任务不存在: ${missionId}`);
    }
    return { missionId, summary, taskChain };
  }

  async listMissionIds(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const missionsDirectory = path.join(this.stateDirectory, "missions");
    try {
      return await readdir(missionsDirectory);
    } catch {
      return [];
    }
  }

  /**
   * T12-04：只读探测单个 mission 目录。单 mission 的损坏（summary/任务链
   * 主文件与备份均不可解析）只标记 corrupted，绝不抛错，保证 status/recover
   * 等只读视图在损坏状态下仍稳定输出并明确上报问题。
   */
  async probeMissionDirectory(
    missionId: string,
  ): Promise<MissionDirectoryProbe> {
    const { readFile } = await import("node:fs/promises");
    let hasSummary = false;
    let summaryStatus: MissionSummary["status"] | null = null;
    let summaryCorrupted = false;
    try {
      const rawSummary = await readFile(this.summaryFilePath(missionId), "utf8");
      hasSummary = true;
      try {
        const parsedSummary = JSON.parse(rawSummary) as Partial<MissionSummary>;
        summaryStatus =
          typeof parsedSummary.status === "string"
            ? (parsedSummary.status as MissionSummary["status"])
            : null;
      } catch {
        summaryCorrupted = true;
      }
    } catch (error) {
      if (!this.isFileNotFoundError(error)) {
        hasSummary = true;
        summaryCorrupted = true;
      }
    }

    let hasTaskChain = false;
    let taskChainCorrupted = false;
    let pendingTaskCount: number | null = null;
    try {
      const chain = await this.taskStore.readTaskChain(missionId);
      if (chain !== null) {
        hasTaskChain = true;
        pendingTaskCount = chain.tasks.filter(
          (task) => task.status !== "done",
        ).length;
      }
    } catch {
      hasTaskChain = true;
      taskChainCorrupted = true;
    }

    return {
      missionId,
      exists: hasSummary || hasTaskChain,
      hasSummary,
      summaryStatus,
      summaryCorrupted,
      hasTaskChain,
      taskChainCorrupted,
      pendingTaskCount,
    };
  }

  private isFileNotFoundError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
