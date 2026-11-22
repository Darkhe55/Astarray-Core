/**
 * COORD-05 05-01（2026-11-22）：**责任与交接**。
 *
 * 目标：把"谁负责、谁发布、读什么、交付什么、哪些事能自己决定、何时请示"
 * 从**权威记录**推导出来，而不是让模型自述。
 *
 * - 只补缺失字段：任务链/移交文档已有字段原样保留，不覆盖；
 * - 发布者缺失时按**已验证的归属关系**（创建者）回退；仍无法确定则如实报告缺失；
 * - 组队提示由同一份记录生成（可自行决定 / 需先读材料 / 何时请示）。
 */
import type { TaskDependencyNode } from "../core/types.js";
import type { EscalationDocumentReference } from "./escalation-contract.js";

export interface ResponsibilityHandoffInput {
  /** 输入材料（文档 + 固定 revision）。 */
  readonly inputReferences?: ReadonlyArray<EscalationDocumentReference>;
  /** 期望交付物（文档 + revision；未产出时先记 0）。 */
  readonly outputReferences?: ReadonlyArray<EscalationDocumentReference>;
}

export type PublisherResolutionKind = "recorded" | "via-creator" | "missing";

export interface ResponsibilityRecord {
  readonly taskIdentifier: string;
  readonly taskType: string;
  readonly ownerAgentInstanceId: string | null;
  readonly publisherAgentInstanceId: string | null;
  readonly publisherResolution: PublisherResolutionKind;
  readonly dependsOn: ReadonlyArray<string>;
  readonly toolNames: ReadonlyArray<string>;
  readonly acceptanceCriteria: string | null;
  readonly inputReferences: ReadonlyArray<EscalationDocumentReference>;
  readonly outputReferences: ReadonlyArray<EscalationDocumentReference>;
  /** 本级能自行决定的事项（空数组 ⇒ 必须请示）。 */
  readonly canDecideIndependently: ReadonlyArray<string>;
  /** 缺失但**影响判断**的字段（如实报告，不猜测）。 */
  readonly missingFields: ReadonlyArray<string>;
  /** 应向上请示的触发条件（可读文本）。 */
  readonly escalationTriggers: ReadonlyArray<string>;
}

/**
 * 构建责任记录（纯函数）。
 *
 * `resolveCreatorOf` 用于发布者缺失时按已验证归属关系回退；返回 null 表示无上级
 * ⇒ 记为 missing（如实报告），不按"最近任务"猜测。
 */
export async function buildResponsibilityRecord(input: {
  readonly task: TaskDependencyNode;
  readonly handoff?: ResponsibilityHandoffInput;
  readonly resolveCreatorOf?: (agentInstanceId: string) => Promise<string | null>;
}): Promise<ResponsibilityRecord> {
  const { task } = input;
  const missingFields: string[] = [];
  const escalationTriggers: string[] = [];
  const canDecideIndependently: string[] = [];

  const owner = task.assignedAgentId?.trim() ?? "";
  if (owner === "") {
    missingFields.push("ownerAgentInstanceId");
  }

  let publisher = task.publishedByRecipientId?.trim() ?? "";
  let publisherResolution: PublisherResolutionKind = "recorded";
  if (publisher === "") {
    publisherResolution = "missing";
    if (owner !== "" && input.resolveCreatorOf !== undefined) {
      const creator = await input.resolveCreatorOf(owner);
      if (creator !== null && creator.trim() !== "") {
        publisher = creator.trim();
        publisherResolution = "via-creator";
      }
    }
    if (publisher === "") {
      missingFields.push("publisherAgentInstanceId");
      escalationTriggers.push("发布者未记录：先按归属关系确认发布者，仍无法确定则请示直属上级。");
    }
  }

  const acceptanceCriteria = task.acceptanceCriteria?.trim() ?? "";
  if (acceptanceCriteria === "") {
    missingFields.push("acceptanceCriteria");
    escalationTriggers.push("验收要求未声明：无法判断“做到什么算完成”，需请示确认。");
  }

  const inputReferences = [...(input.handoff?.inputReferences ?? [])];
  const outputReferences = [...(input.handoff?.outputReferences ?? [])];
  for (const reference of [...inputReferences, ...outputReferences]) {
    if (reference.documentIdentifier.trim() === "" || reference.revision < 0) {
      throw new Error("交接文档引用必须带非空标识与非负 revision。");
    }
  }
  if (input.handoff?.inputReferences === undefined) {
    missingFields.push("inputReferences");
    escalationTriggers.push("未声明输入材料：需要时按任务描述定位，不得凭模型自述补全。");
  }
  if (input.handoff?.outputReferences === undefined) {
    missingFields.push("outputReferences");
  }

  const isBlockedByDependencies = task.dependsOn.length > 0;
  if (!isBlockedByDependencies && owner !== "" && acceptanceCriteria !== "") {
    canDecideIndependently.push("验收要求明确且无前置依赖：可在任务范围内自行决定执行方式。");
  }
  if (isBlockedByDependencies) {
    escalationTriggers.push(
      "存在前置依赖：" + task.dependsOn.join(",") + "；依赖未完成前不得自行推进。",
    );
  }
  if (task.toolNames.length === 0) {
    canDecideIndependently.push("未分配工具：只能做不需要工具的判断，需要工具时请示。");
  }

  return {
    taskIdentifier: task.id,
    taskType: task.taskType,
    ownerAgentInstanceId: owner === "" ? null : owner,
    publisherAgentInstanceId: publisher === "" ? null : publisher,
    publisherResolution,
    dependsOn: [...task.dependsOn],
    toolNames: [...task.toolNames],
    acceptanceCriteria: acceptanceCriteria === "" ? null : acceptanceCriteria,
    inputReferences,
    outputReferences,
    canDecideIndependently,
    missingFields,
    escalationTriggers,
  };
}

/**
 * 由责任记录生成**组队提示**（确定文本，不含模型自述）。
 *
 * 顺序固定：可自行决定 → 该读的材料 → 何时请示；缺失字段如实列出。
 */
export function describeResponsibilityInstructions(
  record: ResponsibilityRecord,
): ReadonlyArray<string> {
  const lines: string[] = [];
  lines.push(
    `任务 ${record.taskIdentifier}（类型 ${record.taskType}）：负责人 ${record.ownerAgentInstanceId ?? "未登记"}`,
  );
  if (record.publisherAgentInstanceId !== null) {
    const source =
      record.publisherResolution === "via-creator" ? "（按归属关系回退）" : "";
    lines.push(`发布者 ${record.publisherAgentInstanceId}${source}；超出权限时向发布者请示。`);
  }
  lines.push(
    record.canDecideIndependently.length === 0
      ? "可自行决定：无（先补齐缺失字段或请示）。"
      : "可自行决定：" + record.canDecideIndependently.join(" "),
  );
  if (record.inputReferences.length === 0) {
    lines.push("该读的材料：未声明（需要时按任务描述定位，不得凭模型自述补全）。");
  } else {
    lines.push(
      "该读的材料：" +
        record.inputReferences
          .map((reference) => `${reference.documentIdentifier}@rev${String(reference.revision)}`)
          .join("、"),
    );
  }
  if (record.escalationTriggers.length > 0) {
    lines.push("何时请示：" + record.escalationTriggers.join(" "));
  }
  if (record.missingFields.length > 0) {
    lines.push("缺失字段（如实报告）：" + record.missingFields.join("、"));
  }
  return lines;
}
