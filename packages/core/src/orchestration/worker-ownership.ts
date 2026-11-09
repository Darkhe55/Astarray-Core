/**
 * ALIGN-03-01/04（2026-11-10）：**Worker 直属上级解析**（用户归属裁决）。
 *
 * 裁决要点（作为实现依据，不得绕过）：
 * 1. 调度器**不是** Agent 的上级，只是执行机制；
 * 2. 调度器直接派发的三级 Worker，唯一直属上级是**该 mission 的责任次级**；
 * 3. **禁止默认绑主 Agent**；缺失/失效/不匹配 ⇒ **阻断派发并报告**，不猜；
 * 4. 三级派生四级时，四级的直属上级是**该三级**，不直接挂 mission 责任次级；
 * 5. 恢复后保持原绑定；同层通信/句柄转交**不改变**直属上级。
 */

export interface ResolveWorkerDirectSuperiorInput {
  /** 该 mission 持久化的责任次级（缺省 ⇒ 未绑定）。 */
  readonly missionResponsibleSecondaryAgentInstanceId: string | null;
  /** 若本次 Worker 由某个三级派生（四级），其父三级标识；顶层三级为 null。 */
  readonly derivedFromTertiaryAgentInstanceId: string | null;
  /** 主 Agent 标识（**仅用于拒绝**：绝不能被当作上级）。 */
  readonly mainAgentInstanceId: string | null;
  /** mission 所属项目（用于跨项目拒绝）。 */
  readonly missionProjectIdentifier: string | null;
  /** 本次派发目标项目（缺省视为与 mission 相同）。 */
  readonly dispatchProjectIdentifier?: string | null;
}

export type WorkerDirectSuperiorResolution =
  | { readonly kind: "resolved"; readonly superiorAgentInstanceId: string; readonly basis: "mission-responsible-secondary" | "derived-from-tertiary" }
  | { readonly kind: "blocked"; readonly reasonCode: WorkerOwnershipBlockReason; readonly detail: string };

export type WorkerOwnershipBlockReason =
  | "mission-responsible-secondary-unbound"
  | "responsible-secondary-is-main-agent"
  /** 责任次级是 `scheduler:<missionId>` 这类**派发来源标签**：调度器不是 Agent，不能当上级。 */
  | "responsible-secondary-is-scheduler-label"
  | "project-mismatch"
  | "derived-from-self";

/**
 * 解析直属上级。**任何不确定都阻断**，绝不返回主 Agent。
 */
export function resolveWorkerDirectSuperior(
  input: ResolveWorkerDirectSuperiorInput,
): WorkerDirectSuperiorResolution {
  const missionProjectIdentifier = input.missionProjectIdentifier?.trim() ?? "";
  const dispatchProjectIdentifier =
    input.dispatchProjectIdentifier === undefined || input.dispatchProjectIdentifier === null
      ? missionProjectIdentifier
      : input.dispatchProjectIdentifier.trim();
  if (
    missionProjectIdentifier !== "" &&
    dispatchProjectIdentifier !== "" &&
    missionProjectIdentifier !== dispatchProjectIdentifier
  ) {
    return {
      kind: "blocked",
      reasonCode: "project-mismatch",
      detail:
        "跨项目派发被拒绝：mission 属 " +
        missionProjectIdentifier +
        "，派发目标为 " +
        dispatchProjectIdentifier,
    };
  }

  /** 四级：直属上级就是派生它的三级（不挂 mission 责任次级）。 */
  const derivedFrom = input.derivedFromTertiaryAgentInstanceId?.trim() ?? "";
  if (derivedFrom !== "") {
    if (derivedFrom === input.mainAgentInstanceId) {
      return {
        kind: "blocked",
        reasonCode: "derived-from-self",
        detail: "派生来源不能是主 Agent：四级的上级必须是三级个体。",
      };
    }
    return {
      kind: "resolved",
      superiorAgentInstanceId: derivedFrom,
      basis: "derived-from-tertiary",
    };
  }

  const responsibleSecondary =
    input.missionResponsibleSecondaryAgentInstanceId?.trim() ?? "";
  if (responsibleSecondary === "") {
    return {
      kind: "blocked",
      reasonCode: "mission-responsible-secondary-unbound",
      detail:
        "该 mission 未绑定责任次级：拒绝派发（不得退回主 Agent，也不猜测身份）。",
    };
  }
  if (responsibleSecondary.startsWith("scheduler:")) {
    return {
      kind: "blocked",
      reasonCode: "responsible-secondary-is-scheduler-label",
      detail:
        "责任次级是调度器标签（" +
        responsibleSecondary +
        "）：调度器只是执行机制，不是 Agent，不能充当上级。",
    };
  }
  if (
    input.mainAgentInstanceId !== null &&
    responsibleSecondary === input.mainAgentInstanceId
  ) {
    return {
      kind: "blocked",
      reasonCode: "responsible-secondary-is-main-agent",
      detail: "责任次级不能是主 Agent：调度器不是上级，主 Agent 也不是默认上级。",
    };
  }
  return {
    kind: "resolved",
    superiorAgentInstanceId: responsibleSecondary,
    basis: "mission-responsible-secondary",
  };
}
