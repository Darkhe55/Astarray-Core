/**
 * COORD-01-03（卡 §2/§5）：**控制旁路**。
 *
 * 卡内要求：
 * - 可信来源的取消 / 暂停 / 撤权 / 紧急停止走**独立控制通道**，**先更新本地执行门禁**；
 * - 不等待 idle、不等待任务窗口、**不依赖模型阅读**；
 * - 分类由本地可信事件类型与来源权限决定，**不接受模型把消息自标为 control 取得优先权**；
 * - 在途取消**依工具能力确认**，`unknown` **不当作已停止**；不支持取消时**如实报告并禁止后续动作**。
 *
 * 本模块只做"门禁 + 在途判定"，不直接终止进程：是否真的停得掉由工具能力决定，结果如实回报。
 */

export type ControlCommandKind = "cancel" | "pause" | "revoke" | "emergency-stop";

/** 来源种类：只有 user/system 属可信控制来源；agent 不得自授控制权。 */
export type ControlSourceKind = "user" | "system" | "agent";

export interface ControlEvent {
  readonly eventIdentifier: string;
  readonly kind: ControlCommandKind;
  readonly source: {
    readonly sourceKind: ControlSourceKind;
    readonly sourceIdentifier: string;
  };
  readonly targetMissionIdentifier: string;
  readonly issuedAtIso: string;
}

/** 在途工具的取消能力（由工具层给出，不由模型声明）。 */
export type InFlightCancellationCapability = "supports-cancel" | "does-not-support-cancel" | "unknown";

export type InFlightCancellationResolution = "confirmed-stopped" | "unknown" | "unsupported";

export interface ControlApplicationResult {
  readonly outcome: "applied" | "duplicate-ignored" | "rejected-untrusted-source";
  readonly isExecutionBlocked: boolean;
  /** 在途操作的处置结果；无在途操作时缺省。 */
  readonly inFlightResolution?: InFlightCancellationResolution;
  readonly detail: string;
}

/**
 * 本地执行门禁 + 控制事件幂等应用。
 *
 * 门禁**同步生效**（调用返回前即已阻止后续动作），因此不依赖模型是否读到消息、也不等待 idle。
 */
export class ControlBypassController {
  /** mission ⇒ 是否被控制事件阻止。 */
  private readonly blockedMissions = new Set<string>();
  /** 已处理事件标识（幂等：重复控制不得重复计数或重复放宽）。 */
  private readonly processedEventIdentifiers = new Set<string>();

  applyControlEvent(input: {
    event: ControlEvent;
    inFlightCapability?: InFlightCancellationCapability;
    hasInFlightOperation?: boolean;
  }): ControlApplicationResult {
    const { event } = input;

    /** ① 来源可信性：模型/普通 agent 不得自标 control。 */
    if (event.source.sourceKind === "agent") {
      return {
        outcome: "rejected-untrusted-source",
        isExecutionBlocked: this.blockedMissions.has(event.targetMissionIdentifier),
        detail: "agent 来源不能发起控制事件（不得自授控制权）",
      };
    }

    /** ② 幂等：同一事件标识重复到达只生效一次。 */
    if (this.processedEventIdentifiers.has(event.eventIdentifier)) {
      return {
        outcome: "duplicate-ignored",
        isExecutionBlocked: this.blockedMissions.has(event.targetMissionIdentifier),
        detail: "该控制事件已处理：幂等忽略",
      };
    }
    this.processedEventIdentifiers.add(event.eventIdentifier);

    /** ③ 先更新本地门禁：立即生效，不等 idle / 任务窗口 / 模型阅读。 */
    this.blockedMissions.add(event.targetMissionIdentifier);

    let inFlightResolution: InFlightCancellationResolution | undefined;
    if (input.hasInFlightOperation === true) {
      const capability = input.inFlightCapability ?? "unknown";
      if (capability === "supports-cancel") {
        inFlightResolution = "confirmed-stopped";
      } else if (capability === "does-not-support-cancel") {
        /** 如实报告：停不掉，但门禁仍阻止**后续**动作。 */
        inFlightResolution = "unsupported";
      } else {
        /** 关键：能力未知时**不得**报成已停止。 */
        inFlightResolution = "unknown";
      }
    }

    return {
      outcome: "applied",
      isExecutionBlocked: true,
      ...(inFlightResolution === undefined ? {} : { inFlightResolution }),
      detail:
        inFlightResolution === undefined
          ? `控制事件 ${event.kind} 已生效：门禁阻止后续动作`
          : `控制事件 ${event.kind} 已生效；在途处置=${inFlightResolution}`,
    };
  }

  /** 门禁查询：派发/执行前必须查，返回 true 时禁止任何新动作。 */
  isExecutionBlocked(missionIdentifier: string): boolean {
    return this.blockedMissions.has(missionIdentifier);
  }

  /** 显式解除（仅由有权控制器在人工确认后调用；本模块不提供自动解除）。 */
  clearBlock(missionIdentifier: string): void {
    this.blockedMissions.delete(missionIdentifier);
  }
}
