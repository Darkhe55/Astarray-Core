/**
 * WIRING-04-04（2026-11-17 返修卡，**方案 C**）：当前任务包的解析。
 *
 * 权威来源是**个体任务序列**：mission 节点不保存第二份可独立更新的包正文。
 * 解析链：
 *
 * ```text
 * mission task ──(精确映射)──▶ agent sequence task ──▶ contextPack + revision
 * ```
 *
 * 三种结果必须区分（卡内要求）：
 * - `no-pack-declared`：确实没绑定包 ⇒ 无包运行（合法）；
 * - `pack`：返回包内容 + **固定 revision** + 内容哈希；
 * - `mapping-missing` / `declared-but-missing`：**阻塞该任务**，
 *   绝不按名称/最近任务/固定 T-001 猜。
 */
import { createHash } from "node:crypto";

import type { ContextPack } from "./context-pack.js";

export interface ContextPackResolutionPort {
  /** 按 **mission task 标识 + 序列标识** 精确查映射（不做模糊匹配）。 */
  findExactBinding(input: {
    readonly missionIdentifier: string;
    readonly missionTaskIdentifier: string;
    readonly sequenceIdentifier: string;
    readonly sequenceOwnerAgentInstanceIdentifier: string;
  }): Promise<{ readonly sequenceTaskIdentifier: string } | null>;
  /** 读取序列节点上的包与 revision。 */
  readSequenceTask(input: {
    readonly sequenceIdentifier: string;
    readonly sequenceOwnerAgentInstanceIdentifier: string;
    readonly sequenceTaskIdentifier: string;
  }): Promise<{ readonly contextPack: ContextPack | null; readonly revision: number } | null>;
}

/**
 * WIRING-04-04（2026-11-18）：**按任务是否声明来源决定严格度**。
 *
 * - 节点声明了来源（三个字段齐全）⇒ 精确认定是必须的：缺映射或不符 ⇒ `declared-missing`（阻塞）；
 * - 节点未声明来源 ⇒ 沿用过渡态：通配 ⇒ `imprecise`，无任何关联 ⇒ `missing`。
 *
 * 这样不必打开全局严格开关，也不会让"已声明来源"的任务继续宽松运行。
 */
export function classifyContextPackMapping(input: {
  readonly missionTaskIdentifier: string;
  readonly entries: ReadonlyArray<{
    readonly missionTaskIdentifier: string;
    readonly sequenceTaskIdentifier: string;
    readonly sequenceIdentifier: string;
    readonly ownerAgentInstanceIdentifier: string;
  }>;
  readonly declaredSource: {
    readonly sequenceTaskIdentifier?: string;
    readonly sequenceIdentifier?: string;
    readonly ownerAgentInstanceIdentifier?: string;
  } | null;
}):
  | {
      readonly kind: "exact";
      readonly entry: {
        readonly sequenceTaskIdentifier: string;
        readonly sequenceIdentifier: string;
        readonly ownerAgentInstanceIdentifier: string;
      };
    }
  | { readonly kind: "declared-missing"; readonly reason: string }
  | { readonly kind: "imprecise"; readonly reason: string }
  | { readonly kind: "missing"; readonly reason: string } {
  const declared = input.declaredSource;
  const isDeclaredComplete =
    declared !== null &&
    typeof declared.sequenceTaskIdentifier === "string" &&
    declared.sequenceTaskIdentifier.trim() !== "" &&
    typeof declared.sequenceIdentifier === "string" &&
    declared.sequenceIdentifier.trim() !== "" &&
    typeof declared.ownerAgentInstanceIdentifier === "string" &&
    declared.ownerAgentInstanceIdentifier.trim() !== "";

  const exactEntry = input.entries.find(
    (entry) => entry.missionTaskIdentifier === input.missionTaskIdentifier,
  );

  if (isDeclaredComplete) {
    if (
      exactEntry === undefined ||
      exactEntry.sequenceTaskIdentifier !== declared.sequenceTaskIdentifier ||
      exactEntry.sequenceIdentifier !== declared.sequenceIdentifier ||
      exactEntry.ownerAgentInstanceIdentifier !== declared.ownerAgentInstanceIdentifier
    ) {
      return {
        kind: "declared-missing",
        reason:
          exactEntry === undefined
            ? `节点声明来源（序列任务 ${declared.sequenceTaskIdentifier}），但缺少精确映射：必要输入不可得`
            : `节点声明的来源与映射不一致（声明 ${declared.sequenceTaskIdentifier}/${declared.sequenceIdentifier}，映射 ${exactEntry.sequenceTaskIdentifier}/${exactEntry.sequenceIdentifier}）：不按映射猜`,
      };
    }
    return { kind: "exact", entry: exactEntry };
  }

  if (exactEntry !== undefined) {
    /** 未声明来源却存在精确项：按精确项用（不额外加锁）。 */
    return { kind: "exact", entry: exactEntry };
  }
  const hasWildcardBinding = input.entries.some(
    (entry) => entry.missionTaskIdentifier === "*",
  );
  return hasWildcardBinding
    ? {
        kind: "imprecise",
        reason: `mission 只有整 mission 级关联（*），无法确定 mission task ${input.missionTaskIdentifier} 的包`,
      }
    : {
        kind: "missing",
        reason: `缺少 mission task ${input.missionTaskIdentifier} 的精确映射`,
      };
}

export type ContextPackResolution =
  | { readonly kind: "no-pack-declared" }
  | {
      readonly kind: "pack";
      readonly pack: ContextPack;
      readonly revision: number;
      readonly contentHash: string;
    }
  | { readonly kind: "mapping-missing"; readonly reason: string }
  | { readonly kind: "declared-but-missing"; readonly reason: string };

export function computeContextPackContentHash(pack: ContextPack): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        packIdentifier: pack.packIdentifier,
        mergePolicy: pack.mergePolicy,
        sourcePriority: pack.sourcePriority,
        members: pack.members.map((member) => ({
          memberIdentifier: member.memberIdentifier,
          sourceKind: member.sourceKind,
          summary: member.summary,
          contentFingerprint: member.contentFingerprint ?? null,
        })),
      }),
    )
    .digest("hex");
}

export async function resolveContextPackForMissionTask(input: {
  readonly missionIdentifier: string;
  readonly missionTaskIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly sequenceOwnerAgentInstanceIdentifier: string;
  readonly port: ContextPackResolutionPort;
}): Promise<ContextPackResolution> {
  const binding = await input.port.findExactBinding({
    missionIdentifier: input.missionIdentifier,
    missionTaskIdentifier: input.missionTaskIdentifier,
    sequenceIdentifier: input.sequenceIdentifier,
    sequenceOwnerAgentInstanceIdentifier: input.sequenceOwnerAgentInstanceIdentifier,
  });
  if (binding === null) {
    return {
      kind: "mapping-missing",
      reason: `缺少 mission task ${input.missionTaskIdentifier} 与序列 ${input.sequenceIdentifier} 的精确映射（不按名称或最近任务猜）`,
    };
  }

  const sequenceTask = await input.port.readSequenceTask({
    sequenceIdentifier: input.sequenceIdentifier,
    sequenceOwnerAgentInstanceIdentifier: input.sequenceOwnerAgentInstanceIdentifier,
    sequenceTaskIdentifier: binding.sequenceTaskIdentifier,
  });
  if (sequenceTask === null) {
    return {
      kind: "declared-but-missing",
      reason: `映射指向序列任务 ${binding.sequenceTaskIdentifier}，但该节点读取不到（不当作"未声明包"）`,
    };
  }
  if (sequenceTask.contextPack === null) {
    return { kind: "no-pack-declared" };
  }
  if (sequenceTask.revision <= 0) {
    /** 卡内明确禁止 `pinnedRevision=0` 占位：没有真实 revision 就不能固定版本。 */
    return {
      kind: "declared-but-missing",
      reason: `序列任务 ${binding.sequenceTaskIdentifier} 声明了包，但缺少有效 revision（不得用 0 占位）`,
    };
  }
  return {
    kind: "pack",
    pack: sequenceTask.contextPack,
    revision: sequenceTask.revision,
    contentHash: computeContextPackContentHash(sequenceTask.contextPack),
  };
}
