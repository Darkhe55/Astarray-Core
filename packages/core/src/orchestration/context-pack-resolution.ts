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
