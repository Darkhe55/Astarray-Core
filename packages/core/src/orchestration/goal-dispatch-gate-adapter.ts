/**
 * AXIOMATIC-DESIGN 阶段④（P4，2026-11-26）：**目标门禁适配器**。
 *
 * 从 `main-controller.observeGoalDispatchGate` 抽出 mission 级派发观察：
 * - 端口：gate 解析器、mission→项目标识、强制开关、判定记录回调、流式输出、时钟；
 * - 行为逐字一致：未装配解析器 / 解析为 null ⇒ 不阻断；判定必记录；
 *   只有 `isGoalModeEnforcementEnabled === true` 才真的阻断；
 * - 适配器**不替代**工具权限/备份门禁，只做目标一致性检查。
 */
import type { GoalDispatchGate } from "./goal-dispatch-gate.js";

/** 目标门禁判定记录（清单第 ⑥ 项；只读观察用）。 */
export interface GoalDispatchVerdictRecord {
  readonly missionIdentifier: string;
  readonly projectIdentifier: string;
  readonly contractRevision: number;
  readonly isAllowed: boolean;
  readonly reasonCode: string | null;
  readonly detail: string | null;
  readonly evidenceGaps: readonly string[];
  /** 本次判定是否真的阻断了派发（false = 仅观察）。 */
  readonly isEnforced: boolean;
  readonly observedAtIso: string;
}

export interface GoalDispatchGateAdapterPorts {
  /** 未装配 ⇒ 返回 null（与"解析为 null"同义：不阻断）。 */
  resolveGate(missionIdentifier: string): GoalDispatchGate | null;
  readProjectIdentifier(missionIdentifier: string): string;
  isEnforcementEnabled(): boolean;
  onVerdict(record: GoalDispatchVerdictRecord): void;
  streamOutput(missionIdentifier: string, text: string): void;
  nowIso(): string;
}

export interface GoalDispatchObservation {
  readonly isBlocked: boolean;
  readonly detail: string | null;
}

export class GoalDispatchGateAdapter {
  constructor(private readonly ports: GoalDispatchGateAdapterPorts) {}

  /**
   * 目标门禁只读观察/可选强制。
   *
   * 未装配 resolver ⇒ 直接返回"未阻断"（行为不变）。
   * 装配后：判定必记录；只有 `isEnforcementEnabled()` 为 true 才真的阻断派发。
   */
  observeMissionDispatch(missionId: string): GoalDispatchObservation {
    const gate = this.ports.resolveGate(missionId);
    if (gate === null) {
      return { isBlocked: false, detail: null };
    }
    const state = gate.getState();
    const projectIdentifier = this.ports.readProjectIdentifier(missionId);
    const observedAtIso = this.ports.nowIso();
    const verdict = gate.assertMissionDispatchAllowed({
      requestedContractRevision: state.contractRevision,
      projectIdentifier,
      nowIso: observedAtIso,
    });
    const isEnforced = this.ports.isEnforcementEnabled();
    const record: GoalDispatchVerdictRecord = {
      missionIdentifier: missionId,
      projectIdentifier,
      contractRevision: state.contractRevision,
      isAllowed: verdict.isAllowed,
      reasonCode: verdict.isAllowed ? null : verdict.reasonCode,
      detail: verdict.isAllowed ? null : verdict.detail,
      evidenceGaps: verdict.isAllowed ? [] : [...verdict.evidenceGaps],
      isEnforced,
      observedAtIso,
    };
    this.ports.onVerdict(record);
    if (!verdict.isAllowed) {
      this.ports.streamOutput(
        missionId,
        `[目标门禁] ${isEnforced ? "阻断派发" : "仅观察（未阻断）"}：${verdict.detail}`,
      );
      if (isEnforced) {
        return { isBlocked: true, detail: verdict.detail };
      }
    }
    return { isBlocked: false, detail: verdict.isAllowed ? null : verdict.detail };
  }
}
