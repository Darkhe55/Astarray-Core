/**
 * CONFIGCHAT-01-03（2026-10-20）：**切换模型/通信依赖的保护、准备与恢复**。
 *
 * 卡内判据（L27）：通信依赖保护、**准备/切换/失败恢复**及 **UI 状态**；
 * 反例：**最后模型禁用**、**目标不可用**、**断网**、**用户主动停止**、**进程重启**、包入口测试。
 *
 * 设计原则（防"说好了其实没好"）：
 * 1. **不能把通信切断**：禁用最后一个可用模型 / 切到不可用模型 ⇒ 拒绝，并说明会断掉什么；
 * 2. **准备 → 切换**两阶段：在途任务存在时切换只能在**安全点**发生，状态必须是 `awaiting-safe-point`，
 *    **不等于已生效**；
 * 3. **失败恢复**：切换失败必须显式给出**回滚到旧模型**的路径（旧模型在恢复前仍可用）；
 * 4. **重启对账**：设置已持久化但运行时仍是旧模型 ⇒ `recovery-needed`（不谎报切换成功）；
 * 5. **用户主动停止** ⇒ `cancelled`，不得继续后台切换。
 */
import { createHash } from "node:crypto";

/** 切换请求。 */
export interface CommunicationModelSwitchRequest {
  readonly requestIdentifier: string;
  /** 当前生效模型（`null` = 尚未选择）。 */
  readonly currentModelIdentifier: string | null;
  /** 目标模型。 */
  readonly targetModelIdentifier: string;
  /** 当前可用模型集合（含目标才算可用）。 */
  readonly availableModelIdentifiers: ReadonlyArray<string>;
  /** 是否有在途任务。 */
  readonly hasInFlightMissions: boolean;
  /** 网络/Provider 是否可达。 */
  readonly isNetworkAvailable: boolean;
  /** 用户是否已主动停止。 */
  readonly isUserCancelled: boolean;
}

/** 切换计划。 */
export type CommunicationModelSwitchPlan =
  | {
      readonly kind: "reject";
      readonly reasonCode:
        | "would-break-communication"
        | "target-unavailable"
        | "network-unavailable"
        | "user-cancelled"
        | "same-model";
      readonly reason: string;
      /** 拒绝后仍然可用的模型（用于 UI 如实展示"现在还能用什么"）。 */
      readonly stillUsableModelIdentifiers: ReadonlyArray<string>;
    }
  | {
      readonly kind: "switch-immediately";
      readonly targetModelIdentifier: string;
      readonly rollbackModelIdentifier: string | null;
    }
  | {
      readonly kind: "switch-at-safe-point";
      readonly targetModelIdentifier: string;
      readonly rollbackModelIdentifier: string | null;
      /** 尚未生效：UI 必须按此显示。 */
      readonly isEffective: false;
      readonly reason: string;
    };

/** UI 状态（穷举；不允许"含糊的已完成"）。 */
export type CommunicationModelSwitchUiState =
  | "preparing"
  | "awaiting-safe-point"
  | "switched"
  | "failed-kept-old"
  | "recovery-needed"
  | "cancelled"
  | "rejected";

/** 计划 → UI 状态。 */
export function describeCommunicationModelSwitchUiState(
  plan: CommunicationModelSwitchPlan,
): CommunicationModelSwitchUiState {
  if (plan.kind === "reject") {
    return plan.reasonCode === "user-cancelled" ? "cancelled" : "rejected";
  }
  if (plan.kind === "switch-at-safe-point") return "awaiting-safe-point";
  return "preparing";
}

/**
 * 规划一次切换（纯函数）。
 *
 * 关键顺序：**先判会不会切断通信**，再判目标是否可用，再判网络，最后判用户取消/在途。
 * 顺序很重要：若先判"同模型"，用户会在断网时看到"无需切换"而误以为一切正常。
 */
export function planCommunicationModelSwitch(
  request: CommunicationModelSwitchRequest,
): CommunicationModelSwitchPlan {
  const usableModels = request.availableModelIdentifiers;

  // ① 禁用最后一个可用模型 ⇒ 直接切断通信
  if (usableModels.length === 0) {
    return {
      kind: "reject",
      reasonCode: "would-break-communication",
      reason: "没有可用模型：禁用后通信会完全中断（拒绝执行，不把用户留在静默状态）。",
      stillUsableModelIdentifiers: [],
    };
  }

  // ② 目标不在可用集合内
  if (!usableModels.includes(request.targetModelIdentifier)) {
    return {
      kind: "reject",
      reasonCode: "target-unavailable",
      reason:
        "目标模型当前不可用：" + request.targetModelIdentifier + "（不切换，避免切过去即失败）。",
      stillUsableModelIdentifiers: usableModels,
    };
  }

  // ③ 断网：切换本身可能依赖 Provider 探测；此时不假装切换成功
  if (!request.isNetworkAvailable) {
    return {
      kind: "reject",
      reasonCode: "network-unavailable",
      reason: "当前网络不可用：无法确认目标模型可达，暂不切换（保持现有模型可用）。",
      stillUsableModelIdentifiers: usableModels,
    };
  }

  // ④ 用户主动停止
  if (request.isUserCancelled) {
    return {
      kind: "reject",
      reasonCode: "user-cancelled",
      reason: "用户已主动停止切换：不再后台重试（需要时请重新发起）。",
      stillUsableModelIdentifiers: usableModels,
    };
  }

  // ⑤ 同模型：无需切换（说明而不制造"已完成"的错觉）
  if (request.currentModelIdentifier === request.targetModelIdentifier) {
    return {
      kind: "reject",
      reasonCode: "same-model",
      reason: "目标与当前模型相同：无需切换。",
      stillUsableModelIdentifiers: usableModels,
    };
  }

  const rollbackModelIdentifier = request.currentModelIdentifier;

  // ⑥ 在途任务 ⇒ 安全点切换，并明确"尚未生效"
  if (request.hasInFlightMissions) {
    return {
      kind: "switch-at-safe-point",
      targetModelIdentifier: request.targetModelIdentifier,
      rollbackModelIdentifier,
      isEffective: false,
      reason: "存在在途任务：等待安全点后切换（当前仍是旧模型在跑）。",
    };
  }

  return {
    kind: "switch-immediately",
    targetModelIdentifier: request.targetModelIdentifier,
    rollbackModelIdentifier,
  };
}

/** 切换执行结果（供 UI 与重启对账使用）。 */
export interface CommunicationModelSwitchOutcome {
  readonly requestIdentifier: string;
  readonly kind: "switched" | "failed-rolled-back" | "failed-kept-old" | "cancelled" | "not-started";
  readonly effectiveModelIdentifier: string | null;
  readonly reason: string;
}

/**
 * 重启后对账：**设置里是目标模型，但运行时仍是旧模型**时，必须报 `recovery-needed`。
 *
 * 这是最容易被谎报的一步（"配置文件写了 = 已切换"）。此处只看**运行时实际生效**的模型。
 */
export function reconcileCommunicationModelSwitchAfterRestart(input: {
  readonly persistedTargetModelIdentifier: string | null;
  readonly runtimeEffectiveModelIdentifier: string | null;
}): {
  readonly kind: "consistent" | "recovery-needed";
  readonly reason: string;
} {
  if (input.persistedTargetModelIdentifier === null) {
    return { kind: "consistent", reason: "没有任何持久化的目标模型：无需对账。" };
  }
  if (input.runtimeEffectiveModelIdentifier === input.persistedTargetModelIdentifier) {
    return { kind: "consistent", reason: "持久化目标与运行时生效模型一致。" };
  }
  return {
    kind: "recovery-needed",
    reason:
      "持久化目标是 " +
      input.persistedTargetModelIdentifier +
      "，但运行时仍是 " +
      String(input.runtimeEffectiveModelIdentifier) +
      "：需要恢复或重新切换（不谎报已切换）。",
  };
}

/** 切换请求指纹（幂等：同指纹不重复切换）。 */
export function computeCommunicationModelSwitchFingerprint(
  request: CommunicationModelSwitchRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.requestIdentifier,
        request.currentModelIdentifier,
        request.targetModelIdentifier,
      ]),
    )
    .digest("hex");
}
