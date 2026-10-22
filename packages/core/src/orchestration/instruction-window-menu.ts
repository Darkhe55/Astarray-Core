/**
 * SMART-01（2026-10-22）：**指令窗口在右键 Agent 菜单中的入口**。
 *
 * 用户决定：指令窗口状态放在「**右键 agent 展开的菜单**」里。
 *
 * 卡内要求（§2、§6）：
 * - 界面支持用户**明确拆分/批量提交**，**显示各条指令**；
 * - 本地入口始终可接受、持久化、**显示排队**，并以**逐条超时状态**揭示未达标；
 * - 窗口满且不能合法释放时**提示积压**（用户可提高窗口/修订/取消/改模式）；
 * - 明确区分「**应用已接收**」和「**主模型已处理**」。
 *
 * 本模块只生成**菜单项**（纯函数），不依赖具体 UI 框架；菜单里不出现"自动代发"这类越权项。
 */

/** 指令窗口状态（供菜单渲染）。 */
export interface InstructionWindowMenuState {
  /** 已接收但未处理完的指令条数。 */
  readonly pendingInstructionCount: number;
  readonly windowCapacity: number;
  /** 超时未达标的指令条数（逐条状态汇总）。 */
  readonly timedOutInstructionCount: number;
  /** 是否已有指令被主模型处理（区别于"已接收"）。 */
  readonly hasProcessedInstruction: boolean;
  readonly isQueueBacklogged: boolean;
}

/** 菜单项。 */
export interface InstructionWindowMenuItem {
  readonly itemIdentifier:
    | "view-instructions"
    | "split-instruction"
    | "batch-submit"
    | "cancel-instruction"
    | "change-window-capacity";
  readonly label: string;
  readonly isEnabled: boolean;
  /** 恒 false：菜单项不代替用户提交/拆分（避免"自动代发"越权）。 */
  readonly isAutomaticOnBehalfOfUser: false;
}

/** 右侧 Agent 菜单中的指令窗口区块。 */
export interface InstructionWindowMenuSection {
  readonly sectionIdentifier: "instruction-window";
  readonly agentInstanceId: string;
  readonly titleText: string;
  /** 状态摘要：始终区分"已接收"与"已处理"。 */
  readonly statusText: string;
  readonly items: ReadonlyArray<InstructionWindowMenuItem>;
  /** 恒 false：本区块不改变任何会话/权限状态。 */
  readonly changesSessionState: false;
}

/**
 * 构建右键 Agent 菜单里的指令窗口区块。
 *
 * 文案纪律：
 * - 有超时 ⇒ 明确写"超时未达标 N 条"，不粉饰；
 * - 积压 ⇒ 提示"窗口已满"，并保留拆分/取消/调整容量入口；
 * - 区分 `已接收` 与 `已处理`（不能用"已完成"混淆）。
 */
export function buildInstructionWindowMenuSection(input: {
  readonly agentInstanceId: string;
  readonly state: InstructionWindowMenuState;
}): InstructionWindowMenuSection {
  const statusParts = [
    "已接收 " + String(input.state.pendingInstructionCount) + " 条",
    "窗口 " + String(input.state.windowCapacity),
  ];
  if (input.state.hasProcessedInstruction) {
    statusParts.push("主模型已处理（区分于已接收）");
  } else {
    statusParts.push("尚未有主模型处理");
  }
  if (input.state.timedOutInstructionCount > 0) {
    statusParts.push("超时未达标 " + String(input.state.timedOutInstructionCount) + " 条");
  }
  if (input.state.isQueueBacklogged) {
    statusParts.push("窗口已满：可拆分/取消/调整容量");
  }

  const items: InstructionWindowMenuItem[] = [
    {
      itemIdentifier: "view-instructions",
      label: "查看各条指令与排队状态",
      isEnabled: true,
      isAutomaticOnBehalfOfUser: false,
    },
    {
      itemIdentifier: "split-instruction",
      label: "拆分本条指令",
      isEnabled: input.state.pendingInstructionCount > 0,
      isAutomaticOnBehalfOfUser: false,
    },
    {
      itemIdentifier: "batch-submit",
      label: "批量提交待处理指令",
      isEnabled: input.state.pendingInstructionCount > 0 && !input.state.isQueueBacklogged,
      isAutomaticOnBehalfOfUser: false,
    },
    {
      itemIdentifier: "cancel-instruction",
      label: "取消选中指令",
      isEnabled: input.state.pendingInstructionCount > 0,
      isAutomaticOnBehalfOfUser: false,
    },
    {
      itemIdentifier: "change-window-capacity",
      label: "调整指令窗口容量",
      isEnabled: true,
      isAutomaticOnBehalfOfUser: false,
    },
  ];

  return {
    sectionIdentifier: "instruction-window",
    agentInstanceId: input.agentInstanceId,
    titleText: "指令窗口",
    statusText: statusParts.join(" · "),
    items,
    changesSessionState: false,
  };
}
