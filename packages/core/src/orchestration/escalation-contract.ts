/**
 * COORD-05 05-02（2026-11-22）：**逐级请示契约与路由**。
 *
 * 规则（卡内）：
 * - 只沿**真实管理树**（创建关系）向上：方向必须严格向上，成环即拒绝；
 * - 本层能决定就本层结案（上层零消息）；越权/无法决断才逐级上报；
 * - 到达主 Agent 仍无法决断 ⇒ 目标为**用户裁决通道**（不广播、不征询同级）；
 * - 每层只**追加**处置结论与引用，不覆盖他人结论；状态迁移由"当前处理人 + 预期版本"保护。
 *
 * 本模块是纯契约与判定（无 I/O）：上级解析、方向/环校验、处置链追加。
 */
export type EscalationRoutingRefusalCode =
  | "unknown-sender"
  | "cycle-detected"
  | "direction-violation"
  | "missing-parent";

export type EscalationRoutingResolution =
  | { readonly kind: "agent"; readonly agentInstanceId: string; readonly chain: ReadonlyArray<string> }
  | { readonly kind: "user"; readonly chain: ReadonlyArray<string> }
  | {
      readonly kind: "refused";
      readonly code: EscalationRoutingRefusalCode;
      readonly reason: string;
    };

export interface EscalationDocumentReference {
  readonly documentIdentifier: string;
  readonly revision: number;
}

export interface EscalationDispositionEntry {
  readonly agentInstanceId: string;
  readonly disposition: "resolved" | "forwarded" | "needs-user";
  readonly reason: string;
  readonly referencedDocumentIdentifiers: ReadonlyArray<string>;
  readonly handledAtIso: string;
}

export type EscalationState =
  | "open"
  | "resolved-by-agent"
  | "needs-user"
  | "answered-by-user";

export interface EscalationRecord {
  readonly requestIdentifier: string;
  readonly originalInitiatorAgentInstanceId: string;
  readonly projectIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly affectedStepIdentifiers: ReadonlyArray<string>;
  readonly questionSummary: string;
  readonly documentReferences: ReadonlyArray<EscalationDocumentReference>;
  /** 当前处理人；null ⇒ 用户裁决通道（只有主层无法决断时进入）。 */
  readonly currentHandlerAgentInstanceId: string | null;
  readonly version: number;
  readonly state: EscalationState;
  readonly dispositions: ReadonlyArray<EscalationDispositionEntry>;
}

const MAXIMUM_MANAGEMENT_DEPTH = 64;

/**
 * 沿**创建关系**解析逐级上报链（从直属上级到主层，不含发送者）。
 *
 * 环 / 缺上级 / 未知发送者都拒绝，并给出稳定原因；不做"猜一个上级"。
 */
export async function resolveEscalationChain(input: {
  readonly senderAgentInstanceId: string;
  readonly resolveCreatorOf: (agentInstanceId: string) => Promise<string | null>;
  readonly isAgentKnown: (agentInstanceId: string) => Promise<boolean>;
}): Promise<EscalationRoutingResolution> {
  const sender = input.senderAgentInstanceId.trim();
  if (sender === "" || !(await input.isAgentKnown(sender))) {
    return { kind: "refused", code: "unknown-sender", reason: `发送者未登记：${sender}` };
  }
  const chain: string[] = [];
  const visited = new Set<string>([sender]);
  let current = sender;
  for (let depth = 0; depth < MAXIMUM_MANAGEMENT_DEPTH; depth += 1) {
    const creator = await input.resolveCreatorOf(current);
    if (creator === null) {
      /** 到达创建者为空的个体 ⇒ 主层；本层无上级 ⇒ 用户通道。 */
      return { kind: "user", chain };
    }
    if (creator === current) {
      return { kind: "refused", code: "cycle-detected", reason: `自指创建关系：${current}` };
    }
    if (visited.has(creator)) {
      return {
        kind: "refused",
        code: "cycle-detected",
        reason: `创建关系成环：${[...visited, creator].join(" → ")}`,
      };
    }
    visited.add(creator);
    chain.push(creator);
    current = creator;
  }
  return {
    kind: "refused",
    code: "cycle-detected",
    reason: `管理链超过上限（${String(MAXIMUM_MANAGEMENT_DEPTH)}），拒绝继续推断`,
  };
}

/**
 * 解析本次上报的**唯一直属上级**（单跳）。
 *
 * 给了 `proposedRecipientAgentInstanceId` 时必须等于解析出的直属上级，
 * 否则按方向违规拒绝（不允许跳到更上层或同级）。
 */
export async function resolveEscalationTarget(input: {
  readonly senderAgentInstanceId: string;
  readonly proposedRecipientAgentInstanceId?: string | null;
  readonly resolveCreatorOf: (agentInstanceId: string) => Promise<string | null>;
  readonly isAgentKnown: (agentInstanceId: string) => Promise<boolean>;
}): Promise<EscalationRoutingResolution> {
  const resolution = await resolveEscalationChain(input);
  if (resolution.kind === "refused") {
    return resolution;
  }
  const directSuperior = resolution.chain[0];
  if (directSuperior === undefined) {
    /** 已到主层：唯一通道是用户。 */
    return resolution;
  }
  const proposed = input.proposedRecipientAgentInstanceId?.trim() ?? "";
  if (proposed !== "" && proposed !== directSuperior) {
    return {
      kind: "refused",
      code: "direction-violation",
      reason: `上报必须发给唯一直属上级 ${directSuperior}，不得越级或改投 ${proposed}`,
    };
  }
  return { kind: "agent", agentInstanceId: directSuperior, chain: resolution.chain };
}

export interface OpenEscalationInput {
  readonly requestIdentifier: string;
  readonly senderAgentInstanceId: string;
  /** 原始发起者；缺省 = 发送者（中间层转交不得改写）。 */
  readonly originalInitiatorAgentInstanceId?: string;
  readonly projectIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly affectedStepIdentifiers: ReadonlyArray<string>;
  readonly questionSummary: string;
  readonly documentReferences: ReadonlyArray<EscalationDocumentReference>;
  readonly proposedRecipientAgentInstanceId?: string | null;
  readonly nowIso: string;
}

export type OpenEscalationOutcome =
  | {
      readonly kind: "opened";
      readonly record: EscalationRecord;
      readonly target:
        | { readonly kind: "agent"; readonly agentInstanceId: string }
        | { readonly kind: "user" };
    }
  | {
      readonly kind: "refused";
      readonly code: EscalationRoutingRefusalCode | "invalid-input";
      readonly reason: string;
    };

/**
 * 打开一条逐级请示：先按真实管理树解析唯一直属上级，再生成可持久化的处置记录。
 *
 * 到主层仍不能决断 ⇒ `currentHandlerAgentInstanceId = null`（用户裁决通道）。
 * 本函数不做 I/O 持久化；调用方负责在写入成功后开始投递。
 */
export async function openEscalation(
  input: OpenEscalationInput,
  deps: {
    readonly resolveCreatorOf: (agentInstanceId: string) => Promise<string | null>;
    readonly isAgentKnown: (agentInstanceId: string) => Promise<boolean>;
  },
): Promise<OpenEscalationOutcome> {
  const requestIdentifier = input.requestIdentifier.trim();
  if (requestIdentifier === "") {
    return { kind: "refused", code: "invalid-input", reason: "原请求标识不能为空。" };
  }
  for (const value of [
    input.projectIdentifier,
    input.missionIdentifier,
    input.taskIdentifier,
    input.questionSummary,
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      return { kind: "refused", code: "invalid-input", reason: "项目/任务/问题摘要不能为空。" };
    }
  }
  for (const stepIdentifier of input.affectedStepIdentifiers) {
    if (stepIdentifier.trim() === "") {
      return { kind: "refused", code: "invalid-input", reason: "受影响步骤标识不能为空字符串。" };
    }
  }
  for (const reference of input.documentReferences) {
    if (reference.documentIdentifier.trim() === "" || !Number.isInteger(reference.revision) || reference.revision < 0) {
      return {
        kind: "refused",
        code: "invalid-input",
        reason: "文档引用必须带非空标识与非负整数 revision。",
      };
    }
  }

  const resolution = await resolveEscalationTarget({
    senderAgentInstanceId: input.senderAgentInstanceId,
    ...(input.proposedRecipientAgentInstanceId === undefined
      ? {}
      : { proposedRecipientAgentInstanceId: input.proposedRecipientAgentInstanceId }),
    resolveCreatorOf: deps.resolveCreatorOf,
    isAgentKnown: deps.isAgentKnown,
  });
  if (resolution.kind === "refused") {
    return resolution;
  }
  const target =
    resolution.kind === "agent"
      ? ({ kind: "agent", agentInstanceId: resolution.agentInstanceId } as const)
      : ({ kind: "user" } as const);
  const record: EscalationRecord = {
    requestIdentifier,
    originalInitiatorAgentInstanceId:
      input.originalInitiatorAgentInstanceId?.trim() || input.senderAgentInstanceId.trim(),
    projectIdentifier: input.projectIdentifier,
    missionIdentifier: input.missionIdentifier,
    taskIdentifier: input.taskIdentifier,
    affectedStepIdentifiers: [...input.affectedStepIdentifiers],
    questionSummary: input.questionSummary,
    documentReferences: [...input.documentReferences],
    currentHandlerAgentInstanceId: target.kind === "agent" ? target.agentInstanceId : null,
    version: 1,
    state: "open",
    dispositions: [],
  };
  return { kind: "opened", record, target };
}

export type EscalationAdvanceOutcome =
  | { readonly kind: "updated"; readonly record: EscalationRecord }
  | {
      readonly kind: "refused";
      readonly code:
        | "stale-version"
        | "handler-mismatch"
        | "already-terminal"
        | "invalid-forward-target";
      readonly reason: string;
    };

/**
 * 追加一层处置结论（**只追加，不覆盖**），并以"当前处理人 + 预期版本"保护状态迁移。
 *
 * - `resolved` ⇒ 终态 `resolved-by-agent`（上层零消息）；
 * - `needs-user` ⇒ 终态 `needs-user`（只有主层可以设置）；
 * - `forwarded` ⇒ 处理人变为 `forwardToAgentInstanceId`（必须不同）；
 * - 版本过期 / 非当前处理人 / 已终态 ⇒ 拒绝，不写任何内容。
 */
export function appendEscalationDisposition(input: {
  readonly record: EscalationRecord;
  readonly expectedVersion: number;
  readonly handlerAgentInstanceId: string;
  readonly disposition: EscalationDispositionEntry["disposition"];
  readonly reason: string;
  readonly referencedDocumentIdentifiers: ReadonlyArray<string>;
  readonly handledAtIso: string;
  readonly forwardToAgentInstanceId?: string | null;
}): EscalationAdvanceOutcome {
  const { record } = input;
  if (record.version !== input.expectedVersion) {
    return {
      kind: "refused",
      code: "stale-version",
      reason: `预期版本 ${String(input.expectedVersion)} 与当前 ${String(record.version)} 不一致`,
    };
  }
  /** 终态优先判定：结案后任何追加都按"已终态"拒绝（不暴露处理人细节）。 */
  if (record.state !== "open") {
    return {
      kind: "refused",
      code: "already-terminal",
      reason: `请求已是终态：${record.state}`,
    };
  }
  if (record.currentHandlerAgentInstanceId !== input.handlerAgentInstanceId) {
    return {
      kind: "refused",
      code: "handler-mismatch",
      reason: "只有当前处理人可以追加处置结论。",
    };
  }
  const referenced = [...input.referencedDocumentIdentifiers];
  if (referenced.some((identifier) => identifier.trim() === "")) {
    return {
      kind: "refused",
      code: "invalid-forward-target",
      reason: "引用的文档标识不能为空字符串。",
    };
  }

  const nextHandler = (() => {
    if (input.disposition === "forwarded") {
      const target = input.forwardToAgentInstanceId?.trim() ?? "";
      if (target === "" || target === input.handlerAgentInstanceId) {
        return null;
      }
      return target;
    }
    return input.handlerAgentInstanceId;
  })();
  if (input.disposition === "forwarded" && nextHandler === null) {
    return {
      kind: "refused",
      code: "invalid-forward-target",
      reason: "转交必须指定一个不同于当前处理人的上级。",
    };
  }

  const nextState: EscalationState =
    input.disposition === "resolved"
      ? "resolved-by-agent"
      : input.disposition === "needs-user"
        ? "needs-user"
        : "open";
  const entry: EscalationDispositionEntry = {
    agentInstanceId: input.handlerAgentInstanceId,
    disposition: input.disposition,
    reason: input.reason,
    referencedDocumentIdentifiers: referenced,
    handledAtIso: input.handledAtIso,
  };
  return {
    kind: "updated",
    record: {
      ...record,
      version: record.version + 1,
      state: nextState,
      currentHandlerAgentInstanceId: nextState === "open" ? nextHandler : null,
      dispositions: [...record.dispositions, entry],
    },
  };
}
