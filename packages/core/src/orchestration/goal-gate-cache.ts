/**
 * GOAL-02 R3（2026-10-29）：**门禁解析器缓存**（mission → 还原后的 `GoalDispatchGate`）。
 *
 * 为什么用缓存：`MainController` 的 `goalDispatchGateResolver` 是**同步**签名，
 * 而契约/绑定/状态都在磁盘上（异步读）。所以启动时 `hydrate()` 一次，之后同步 `resolve()`。
 *
 * 还原规则（缺一不可，缺则**不还原**并记录原因）：
 * 1. mission 有绑定；
 * 2. 绑定的目标契约存在且合法；
 * 3. 该目标有持久化状态；
 * 4. 状态里的契约 revision 与契约一致（不一致 ⇒ 拒绝，避免旧预算/暂停套到新版本）。
 *
 * 本模块**只读**：不创建契约、不绑定 mission、不写状态；模式仍由上层开关决定
 * （默认只观察，不阻断）。
 */
import type { GoalDispatchGate } from "./goal-dispatch-gate.js";
import { GoalDispatchGate as GoalDispatchGateClass } from "./goal-dispatch-gate.js";
import type { GoalContractStore } from "./goal-contract-store.js";
import type { GoalMissionBindingStore } from "./goal-mission-binding-store.js";
import type { GoalModeStateStore } from "./goal-mode-store.js";

export interface GoalGateHydrationIssue {
  readonly missionIdentifier: string;
  readonly goalIdentifier: string | null;
  readonly reason:
    | "contract-missing"
    | "contract-invalid"
    | "state-missing"
    | "revision-mismatch"
    | "experiment-closed"
    | "restore-failed";
}

export interface GoalGateHydrationResult {
  readonly restoredCount: number;
  readonly issues: readonly GoalGateHydrationIssue[];
}

export class GoalGateCache {
  private readonly gatesByMission = new Map<string, GoalDispatchGate>();
  private lastHydration: GoalGateHydrationResult = {
    restoredCount: 0,
    issues: [],
  };

  constructor(
    private readonly options: {
      readonly bindingStore: GoalMissionBindingStore;
      readonly contractStore: GoalContractStore;
      readonly stateStore: GoalModeStateStore;
      /**
       * R77（K11）：**外部（任务/调度）工具预算**（可选）。
       *
       * 与契约上限**取更严**；不持久化（属于运行时配置，重启需重新注入）。
       */
      readonly externalToolCallBudget?: {
        readonly maximumToolCalls: number | null;
        readonly source: string;
      } | null;
    },
  ) {}

  /** 同步解析（未绑定/未还原 ⇒ null ⇒ 目标门禁不参与该 mission）。 */
  resolve(missionIdentifier: string): GoalDispatchGate | null {
    return this.gatesByMission.get(missionIdentifier) ?? null;
  }

  getHydrationResult(): GoalGateHydrationResult {
    return this.lastHydration;
  }

  size(): number {
    return this.gatesByMission.size;
  }

  /** 重建缓存（启动时调用；也可在绑定/契约变更后重新调用）。 */
  async hydrate(): Promise<GoalGateHydrationResult> {
    this.gatesByMission.clear();
    const bindings = await this.options.bindingStore.list();
    const issues: GoalGateHydrationIssue[] = [];
    for (const binding of bindings) {
      const contract = await this.options.contractStore
        .read(binding.goalIdentifier)
        .catch(() => null);
      if (contract === null) {
        issues.push({
          missionIdentifier: binding.missionIdentifier,
          goalIdentifier: binding.goalIdentifier,
          reason: "contract-missing",
        });
        continue;
      }
      const state = await this.options.stateStore
        .read(binding.goalIdentifier)
        .catch(() => null);
      if (state === null) {
        issues.push({
          missionIdentifier: binding.missionIdentifier,
          goalIdentifier: binding.goalIdentifier,
          reason: "state-missing",
        });
        continue;
      }
      /**
       * R36（2026-10-29）：**实验已关闭 ⇒ 不还原门禁**。
       *
       * 关闭后不再新增目标派发（解析器返回 null ⇒ 目标模式不参与）；任务/历史/限制**原样保留**
       * （状态文件仍在，`goal-mode status` 可见关闭标记）。
       */
      if (state.isExperimentClosed) {
        issues.push({
          missionIdentifier: binding.missionIdentifier,
          goalIdentifier: binding.goalIdentifier,
          reason: "experiment-closed",
        });
        continue;
      }
      if (state.contractRevision !== contract.revision) {
        issues.push({
          missionIdentifier: binding.missionIdentifier,
          goalIdentifier: binding.goalIdentifier,
          reason: "revision-mismatch",
        });
        continue;
      }
      try {
        const gate = GoalDispatchGateClass.restoreFromSnapshot(
          contract,
          state.gateSnapshot,
        );
        /** R97：恢复已持久化的安全不变量违规（只接受契约声明的标识）。 */
        gate.restoreInvariantViolations(state.invariantViolations ?? []);
        if (
          this.options.externalToolCallBudget !== undefined &&
          this.options.externalToolCallBudget !== null
        ) {
          gate.applyExternalBudgetLimit(this.options.externalToolCallBudget);
        }
        this.gatesByMission.set(binding.missionIdentifier, gate);
      } catch {
        issues.push({
          missionIdentifier: binding.missionIdentifier,
          goalIdentifier: binding.goalIdentifier,
          reason: "restore-failed",
        });
      }
    }
    this.lastHydration = {
      restoredCount: this.gatesByMission.size,
      issues,
    };
    return this.lastHydration;
  }
}
