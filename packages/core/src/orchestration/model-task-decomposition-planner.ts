/**
 * ALIGN-02-02（2026-10-28）：**模型背书的分解候选稿**生产器。
 *
 * 边界（与 `task-decomposition-contract.ts` 分工）：
 * 本模块只负责"拿到候选稿"——把用户任务与可选的项目摘要交给一个**受限的**
 * 规划运行时，收集文本并抽出 JSON；**不做**权威判定。是否接受候选稿，
 * 一律由本地契约（白名单字段/节点数/依赖环/验收要求/工具子集）决定。
 *
 * 三条纪律：
 * 1. 规划调用有自己的预算（默认 120 秒），超时即放弃 —— 不占住会话；
 * 2. 拿不到 JSON 就是失败，**不**编造分解；
 * 3. 该生产器**默认不启用**（装配层显式开启），因为它会真实调用模型，
 *    而本轮交付口径不运行模型验证。
 */
import { DomainError } from "../core/errors.js";
import type { AgentRuntime, TaskDependencyNode } from "../core/types.js";

/** 规划调用的默认预算：120 秒（短于主 Agent 单条处理预算）。 */
export const DEFAULT_TASK_PLANNING_BUDGET_MILLISECONDS = 120_000;

export interface TaskDecompositionRequest {
  readonly missionIdentifier: string;
  readonly instructionText: string;
  /** 必要项目摘要（可为空：没有就明说没有，不让模型猜项目内容）。 */
  readonly projectSummary: string | null;
}

export type TaskDecompositionDraftProvider = (
  request: TaskDecompositionRequest,
) => Promise<unknown>;

export interface ModelBackedTaskDecompositionProviderOptions {
  readonly runtimeFactory: (plannerAgentInstanceIdentifier: string) => AgentRuntime;
  readonly budgetMilliseconds?: number;
  /** R100：可用工具名（规划器只能从这里选；空数组也要明说）。 */
  readonly availableToolNames?: readonly string[];
}

/** 规划运行时需要一个任务节点占位（不是真实执行节点，不会进入任务链）。 */
export function buildPlannerTaskPlaceholder(): TaskDependencyNode {
  return {
    id: "planner",
    description: "生成任务分解候选稿（不是执行节点）",
    dependsOn: [],
    taskType: "data",
    toolNames: [],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

/**
 * 构造"模型产出候选稿"的生产器。
 *
 * 交给模型的提示词刻意只包含：任务原文、可选项目摘要、输出 JSON 形状。
 * 不告诉它任何工具清单之外的信息，也不允许它声明来源/优先级（字段白名单在契约层）。
 */
export function createModelBackedTaskDecompositionProvider(
  options: ModelBackedTaskDecompositionProviderOptions,
): TaskDecompositionDraftProvider {
  const budgetMilliseconds =
    options.budgetMilliseconds ?? DEFAULT_TASK_PLANNING_BUDGET_MILLISECONDS;
  return async (request: TaskDecompositionRequest): Promise<unknown> => {
    const plannerAgentIdentifier = `planner:${request.missionIdentifier}`;
    const runtime = options.runtimeFactory(plannerAgentIdentifier);
    const cancellationSignal = AbortSignal.timeout(budgetMilliseconds);
    const events = runtime.run(
      {
        missionId: request.missionIdentifier,
        agentId: plannerAgentIdentifier,
        systemPrompt:
          "你是任务分解器。把用户任务拆成**有依赖**的执行节点，只输出一个 JSON 对象，不要解释。\n" +
          '格式：{"nodes":[{"id":"T-01","description":"做什么","dependsOn":[],' +
          '"acceptanceCriteria":"怎样算完成","toolNames":[]}]}\n' +
          "要求：节点不超过 12 个；id 只能含字母数字._-；dependsOn 只能引用已出现的 id；" +
          "每个节点必须有可核对的 acceptanceCriteria；不要输出 sourceKind/priorityTier 等权威字段。\n" +
          `可用工具名（toolNames 只能从这里选；没有合适工具就用空数组）：${(options.availableToolNames ?? []).join(", ") || "（无）"}`, 
        userPrompt:
          `用户任务：${request.instructionText}\n` +
          (request.projectSummary === null
            ? "项目摘要：无（不要臆测项目内容）\n"
            : `项目摘要：${request.projectSummary}\n`),
        availableToolDescriptors: [],
        /** 单轮：不做工具循环，只取一次文本答复。 */
        maxLoopIterations: 1,
      },
      cancellationSignal,
    );

    let collectedText = "";
    try {
      for await (const event of events) {
        if (event.kind === "textDelta") {
          collectedText += event.deltaText;
        }
      }
    } catch (error) {
      if (cancellationSignal.aborted) {
        throw new DomainError(
          "task-decomposition-invalid",
          `分解规划超过 ${String(Math.round(budgetMilliseconds / 1000))} 秒预算，已放弃（不编造分解）。`,
        );
      }
      throw error;
    }
    return extractJsonObject(collectedText);
  };
}

/** 从模型文本里抽出第一个完整 JSON 对象；抽不出就如实失败。 */
export function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    throw new DomainError(
      "task-decomposition-invalid",
      "规划模型没有返回任何文本，无法得到分解候选稿。",
    );
  }
  const startIndex = trimmed.indexOf("{");
  const endIndex = trimmed.lastIndexOf("}");
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new DomainError(
      "task-decomposition-invalid",
      "规划模型输出里没有 JSON 对象，拒绝猜测分解。",
    );
  }
  try {
    return JSON.parse(trimmed.slice(startIndex, endIndex + 1)) as unknown;
  } catch {
    throw new DomainError(
      "task-decomposition-invalid",
      "规划模型输出的 JSON 无法解析，拒绝接受半成品分解。",
    );
  }
}
