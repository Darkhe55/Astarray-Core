/**
 * WORKWINDOW-01-02（2026-10-20）：**统一门禁**（派发 / 模型 / 工具执行前）。
 *
 * 卡内判据（L 行）："在派发/模型/工具执行前统一门禁，接入既有暂停与恢复；长工具、独立反馈、watchdog、
 * 权限到期、**多个暂停原因不互相覆盖**"。
 *
 * 本模块把既有 `work-window-contract` 的状态判定与 `PauseReasonState` 组合成**一个**门禁：
 * - 三个门禁点（dispatch/model/tool）用**同一套**判定，不允许某处漏判；
 * - **暂停原因全部保留**（返回完整列表与"谁新增/谁清除"），不因后来的原因覆盖先前的；
 * - **已在执行的长工具**允许跑完（`isLongRunningContinuation`），但**不得据此再派发新工作**；
 * - **独立反馈**（进度/心跳回执）不受休息拦截，但**不产生模型或业务请求**；
 * - **权限到期 / watchdog** 视作暂停原因参与合并，而不是各自偷偷拦截。
 */
import {
  evaluateWorkWindowState,
  type PauseReasonState,
  type WorkWindowRule,
} from "./work-window-contract.js";

/** 三个统一门禁点。 */
export type WorkWindowGatePoint = "dispatch" | "model" | "tool-execution";

/** 门禁请求。 */
export interface WorkWindowGateRequest {
  readonly gatePoint: WorkWindowGatePoint;
  readonly nowIso: string;
  readonly rules: ReadonlyArray<WorkWindowRule>;
  readonly pauseReasonState: PauseReasonState;
  /** 是否已在执行中的长工具（允许收尾，不允许开新活）。 */
  readonly isLongRunningContinuation?: boolean;
  /** 是否是独立反馈（进度/心跳），不产生模型或业务请求。 */
  readonly isIndependentFeedback?: boolean;
}

/** 门禁结论。 */
export type WorkWindowGateDecision =
  | {
      readonly kind: "allow";
      readonly gatePoint: WorkWindowGatePoint;
      readonly reason: string;
      /** 独立反馈通道：明确它**不**产生模型/业务请求。 */
      readonly doesProduceModelOrBusinessRequest: false | boolean;
    }
  | {
      readonly kind: "deny";
      readonly gatePoint: WorkWindowGatePoint;
      readonly reasonCode:
        | "resting"
        | "paused"
        | "resting-and-paused"
        | "required-rule-missing";
      readonly reason: string;
      /** 全部生效中的暂停原因（不覆盖、不折叠）。 */
      readonly activePauseReasonKinds: ReadonlyArray<string>;
      readonly isWorkWindowResting: boolean;
    };

/**
 * 三处统一的判定入口。
 *
 * 顺序（有意为之）：**独立反馈**先放行（它不产生工作）⇒ **长工具收尾**次之 ⇒ 再看暂停与休息。
 * 这样"休息时连收尾都被拦"和"休息时仍派发新活"这两种相反错误都不会发生。
 */
export function evaluateWorkWindowGate(request: WorkWindowGateRequest): WorkWindowGateDecision {
  const activePauseReasonKinds = readActivePauseReasonKinds(request.pauseReasonState);

  if (request.isIndependentFeedback === true) {
    return {
      kind: "allow",
      gatePoint: request.gatePoint,
      reason: "独立反馈（进度/心跳）：不产生模型或业务请求，休息期间也放行。",
      doesProduceModelOrBusinessRequest: false,
    };
  }

  const assessment = evaluateWorkWindowState({
    rules: request.rules,
    instantIso: request.nowIso,
  });
  const isWorkWindowResting = assessment.state === "resting";

  // 长工具收尾：允许，但明确它不能作为新派发的理由
  if (request.isLongRunningContinuation === true && activePauseReasonKinds.length === 0) {
    return {
      kind: "allow",
      gatePoint: request.gatePoint,
      reason: isWorkWindowResting
        ? "已在执行的长工具允许收尾；休息期间**不得**据此派发新工作。"
        : "已在执行的长工具允许收尾。",
      doesProduceModelOrBusinessRequest: true,
    };
  }

  if (activePauseReasonKinds.length > 0) {
    return {
      kind: "deny",
      gatePoint: request.gatePoint,
      reasonCode: isWorkWindowResting ? "resting-and-paused" : "paused",
      reason:
        "存在暂停原因：" + activePauseReasonKinds.join(", ") + "（全部保留，不互相覆盖）。",
      activePauseReasonKinds,
      isWorkWindowResting,
    };
  }

  if (isWorkWindowResting) {
    return {
      kind: "deny",
      gatePoint: request.gatePoint,
      reasonCode: "resting",
      reason: "当前处于休息时段：不派发新工作、不产生模型/工具调用。",
      activePauseReasonKinds,
      isWorkWindowResting,
    };
  }

  return {
    kind: "allow",
    gatePoint: request.gatePoint,
    reason: "在工作时段且无暂停原因。",
    doesProduceModelOrBusinessRequest: true,
  };
}

/**
 * 合并新的暂停原因（watchdog / 权限到期 / 用户暂停）时**不清除其它原因**。
 *
 * 直接复用既有契约的 `applyPauseReasonChange` 语义，但这里额外保证：
 * 新原因加入不会把状态里其它已激活原因标记为清除（防止"后来者覆盖"）。
 */
export function mergePauseReasons(input: {
  readonly state: PauseReasonState;
  readonly addedReasonKinds: ReadonlyArray<string>;
}): { readonly state: PauseReasonState; readonly addedKinds: ReadonlyArray<string> } {
  const addedKinds = input.addedReasonKinds.filter(
    (kind) => input.state.pausedReasons[kind as keyof typeof input.state.pausedReasons] !== true,
  );
  if (addedKinds.length === 0) return { state: input.state, addedKinds: [] };

  const pausedReasons = { ...input.state.pausedReasons };
  for (const kind of addedKinds) {
    pausedReasons[kind as keyof typeof pausedReasons] = true;
  }
  return { state: { ...input.state, pausedReasons }, addedKinds };
}

/** 读取当前生效的暂停原因（全部保留，不覆盖）。 */
export function readActivePauseReasonKinds(state: PauseReasonState): ReadonlyArray<string> {
  return Object.entries(state.pausedReasons)
    .filter(([, isPaused]) => isPaused === true)
    .map(([kind]) => kind);
}
