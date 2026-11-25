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
  /**
   * WIRING-04-04（2026-11-25）：**按固定 revision 读取历史版本**（不可变版本对象）。
   *
   * 缺省未提供 ⇒ 无法读取旧版本：请求固定旧版本时按"必要输入不可得"阻塞，
   * 而不是悄悄换成最新版。
   */
  readSequenceTaskAtRevision?(input: {
    readonly sequenceIdentifier: string;
    readonly sequenceOwnerAgentInstanceIdentifier: string;
    readonly sequenceTaskIdentifier: string;
    readonly revision: number;
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

/**
 * WIRING-04-04 自愈判定：**声明了完整来源、但该任务没有任何映射项**时，
 * 可以按节点声明的三元组补写精确映射（绑定写入可能因创建时异常失败）。
 *
 * 边界：只在"完全缺失"时补；"映射存在但与声明不一致"⇒ **不补**（那是真冲突，必须阻塞）。
 */
export function shouldBackfillDeclaredMapping(input: {
  readonly missionTaskIdentifier: string;
  readonly declaredSource: {
    readonly sequenceTaskIdentifier?: string;
    readonly sequenceIdentifier?: string;
    readonly ownerAgentInstanceIdentifier?: string;
  } | null;
  readonly entries: ReadonlyArray<{ readonly missionTaskIdentifier: string }>;
}): boolean {
  const declared = input.declaredSource;
  if (declared === null) {
    return false;
  }
  const isComplete =
    typeof declared.sequenceTaskIdentifier === "string" &&
    declared.sequenceTaskIdentifier.trim() !== "" &&
    typeof declared.sequenceIdentifier === "string" &&
    declared.sequenceIdentifier.trim() !== "" &&
    typeof declared.ownerAgentInstanceIdentifier === "string" &&
    declared.ownerAgentInstanceIdentifier.trim() !== "";
  if (!isComplete) {
    return false;
  }
  return !input.entries.some(
    (entry) => entry.missionTaskIdentifier === input.missionTaskIdentifier,
  );
}

export type ContextPackResolution =
  | { readonly kind: "no-pack-declared" }
  | {
      readonly kind: "pack";
      readonly pack: ContextPack;
      readonly revision: number;
      readonly contentHash: string;
      /** 固定版本比最新版旧时的**提示**（不自动换版本、不因此拒绝）。 */
      readonly revisionAdvancedNotice?: string | null;
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
  /**
   * WIRING-04-04：固定的包版本与内容哈希（当前任务包/声明的依赖包都必须固定）。
   *
   * - `pinnedRevision` 缺省 ⇒ 用最新 revision（保持既有行为）；
   * - 显式给 0 ⇒ **拒绝**（卡内禁止 `pinnedRevision=0` 占位）；
   * - 旧版本读不到 ⇒ `declared-but-missing`（必要输入 blocked，不自动换最新）；
   * - 最新版已前进 ⇒ `revisionAdvancedNotice` 提示，但**仍用固定旧版本**。
   */
  readonly pinnedRevision?: number | null;
  readonly expectedContentHash?: string | null;
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
  /**
   * 固定旧版本：必须经由不可变版本存储读取；读不到即阻塞，不悄悄换最新版。
   */
  if (input.pinnedRevision !== undefined && input.pinnedRevision !== null) {
    if (!Number.isInteger(input.pinnedRevision) || input.pinnedRevision <= 0) {
      return {
        kind: "declared-but-missing",
        reason: "pinnedRevision 必须是正整数（禁止用 0 占位）。",
      };
    }
    if (input.port.readSequenceTaskAtRevision === undefined) {
      return {
        kind: "declared-but-missing",
        reason: "请求固定旧版本，但解析端口未提供历史版本读取：必要输入不可得（不自动换最新版）。",
      };
    }
    const pinned = await input.port.readSequenceTaskAtRevision({
      sequenceIdentifier: input.sequenceIdentifier,
      sequenceOwnerAgentInstanceIdentifier: input.sequenceOwnerAgentInstanceIdentifier,
      sequenceTaskIdentifier: binding.sequenceTaskIdentifier,
      revision: input.pinnedRevision,
    });
    if (pinned === null || pinned.contextPack === null) {
      return {
        kind: "declared-but-missing",
        reason: `固定版本 revision=${String(input.pinnedRevision)} 不存在或没有包内容（不自动换最新版）。`,
      };
    }
    const pinnedHash = computeContextPackContentHash(pinned.contextPack);
    if (
      input.expectedContentHash !== undefined &&
      input.expectedContentHash !== null &&
      input.expectedContentHash !== pinnedHash
    ) {
      return {
        kind: "declared-but-missing",
        reason: `固定版本内容哈希不符（期望 ${input.expectedContentHash}，实得 ${pinnedHash}）：必要输入 blocked。`,
      };
    }
    const latestRevision = sequenceTask.revision;
    return {
      kind: "pack",
      pack: pinned.contextPack,
      revision: input.pinnedRevision,
      contentHash: pinnedHash,
      revisionAdvancedNotice:
        latestRevision > input.pinnedRevision
          ? `最新 revision=${String(latestRevision)} 已前进；本次仍使用固定 revision=${String(input.pinnedRevision)}（不自动换版本）。`
          : null,
    };
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

/**
 * WIRING-04-04 生产适配器（2026-11-25）：把**真实映射存储 + 序列存储**接成解析端口。
 *
 * - `findExactBinding`：只按 mission task 精确查映射（不做名称/最近任务匹配）；
 * - `readSequenceTask`：读序列文档里的节点包与**文档 revision**；
 * - `readSequenceTaskAtRevision`：当前没有不可变版本存储 ⇒ 仅当 `revision` 恰好等于当前
 *   文档 revision 时返回；否则返回 null（由解析层 blocked，**不用最新版冒充旧版本**）。
 */
export function createSequenceContextPackResolutionPort(input: {
  readonly mapStore: {
    listForMission(input: {
      readonly missionIdentifier: string;
      readonly sequenceIdentifier: string;
    }): Promise<
      ReadonlyArray<{
        readonly missionTaskIdentifier: string;
        readonly sequenceTaskIdentifier: string;
        readonly sequenceIdentifier: string;
        readonly ownerAgentInstanceIdentifier: string;
      }>
    >;
  };
  readonly sequenceStore: {
    readSequence(
      ownerAgentInstanceIdentifier: string,
      sequenceIdentifier: string,
    ): Promise<{
      readonly revision: number;
      readonly nodes: ReadonlyArray<{
        readonly taskId: string;
        readonly contextPack?: ContextPack;
      }>;
    } | null>;
  };
}): ContextPackResolutionPort {
  return {
    async findExactBinding(bindingInput) {
      const entries = await input.mapStore.listForMission({
        missionIdentifier: bindingInput.missionIdentifier,
        sequenceIdentifier: bindingInput.sequenceIdentifier,
      });
      const entry = entries.find(
        (candidate) =>
          candidate.missionTaskIdentifier === bindingInput.missionTaskIdentifier &&
          candidate.sequenceIdentifier === bindingInput.sequenceIdentifier &&
          candidate.ownerAgentInstanceIdentifier ===
            bindingInput.sequenceOwnerAgentInstanceIdentifier,
      );
      return entry === undefined ? null : { sequenceTaskIdentifier: entry.sequenceTaskIdentifier };
    },
    async readSequenceTask(readInput) {
      const document = await input.sequenceStore.readSequence(
        readInput.sequenceOwnerAgentInstanceIdentifier,
        readInput.sequenceIdentifier,
      );
      if (document === null) return null;
      const node = document.nodes.find(
        (candidate) => candidate.taskId === readInput.sequenceTaskIdentifier,
      );
      if (node === undefined) return null;
      return {
        contextPack: node.contextPack ?? null,
        revision: document.revision,
      };
    },
    async readSequenceTaskAtRevision(readInput) {
      const document = await input.sequenceStore.readSequence(
        readInput.sequenceOwnerAgentInstanceIdentifier,
        readInput.sequenceIdentifier,
      );
      if (document === null) return null;
      if (document.revision !== readInput.revision) {
        /** 没有历史版本存储：不能把当前内容冒充旧版本。 */
        return null;
      }
      const node = document.nodes.find(
        (candidate) => candidate.taskId === readInput.sequenceTaskIdentifier,
      );
      if (node === undefined) return null;
      return {
        contextPack: node.contextPack ?? null,
        revision: document.revision,
      };
    },
  };
}