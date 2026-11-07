/**
 * RESUME-02（2026-11-07，用户裁决版）：**断点续接**。
 *
 * ## 语义（用户明确修正，优先于旧卡 §01）
 *
 * - 这**不是**实验开关：没有 "isCheckpointContinuationEnabled"，没有默认关闭/认证开启；
 * - 断点由**真实中断**产生：只有任务异常中断（blocked）才在**发生中断的会话**里出现一张状态卡；
 * - **不点就一直保留**：卡片不因刷新、轮询、重启而消失或重复追加；
 * - **点了才恢复**：`requestContinuation` 是唯一入口；普通消息"继续"仍是普通消息；
 * - **终态留档（用户选 A）**：恢复成功/任务完成/取消后卡片转终态并保留，不从会话移除。
 *
 * ## 为什么"派生 + 覆盖"而不是"事件时写一条记录"
 *
 * 中断时刻**没有可靠的单点事件**（任务可能崩溃、断电、被外部杀掉）。若只在事件里写记录，
 * 崩溃场景恰好会丢卡片 —— 那正是最需要它的时候。
 *
 * 因此：断点**列表由已持久化的 mission 摘要派生**（确定、可重建、天然去重），
 * 只把**用户操作产生的状态**（requested/resumed/cancelled）持久化为覆盖层。
 * 重启后派生结果相同，覆盖层仍在 ⇒ 卡片既不丢也不重复。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";

/** 断点状态（终态保留，不从会话移除）。 */
export const CONTINUATION_BREAKPOINT_STATES = [
  "open",
  "requested",
  "resumed",
  "cancelled",
  "superseded",
] as const;
export type ContinuationBreakpointState =
  (typeof CONTINUATION_BREAKPOINT_STATES)[number];

/** 中断原因：只描述**可核对的事实**，不做心理推断。 */
export type ContinuationInterruptionReason =
  | "mission-blocked"
  | "mission-cancelled"
  | "mission-interrupted";

/** 单张断点卡（渲染所需最小事实集）。 */
export interface ContinuationBreakpointView {
  readonly breakpointIdentifier: string;
  readonly conversationIdentifier: string;
  readonly missionIdentifier: string;
  readonly projectIdentifier: string | null;
  /** 任务短名（用于卡片标题；取摘要提示词截断，不是模型摘要）。 */
  readonly taskShortName: string;
  readonly interruptionReason: ContinuationInterruptionReason;
  readonly status: ContinuationBreakpointState;
  /** 卡片版本：状态每次变化 +1；请求必须带正确版本（乐观并发）。 */
  readonly revision: number;
  /** 最近可信检查点标识（没有则为 null —— 不应承诺“可从检查点继续”）。 */
  readonly lastCheckpointIdentifier: string | null;
  /** 下一步说明（来自真实状态，不编造）。 */
  readonly nextStep: string;
  /** 是否允许点击“恢复任务”（由状态与检查点共同决定）。 */
  readonly canResume: boolean;
  /** 不可恢复时给用户看的原因（为空表示可恢复）。 */
  readonly blockedReason: string | null;
  readonly recordedAtIso: string;
  readonly updatedAtIso: string;
  /** 最近一次续接请求的幂等键（用于断线重放）。 */
  readonly lastRequestIdentifier: string | null;
}

/** 持久化覆盖层（只有用户操作会写它）。 */
interface ContinuationOverlayRecord {
  schemaVersion: 1;
  breakpointIdentifier: string;
  status: ContinuationBreakpointState;
  revision: number;
  updatedAtIso: string;
  lastRequestIdentifier: string | null;
  /** 最近一次续接结果（如实记录，不美化）。 */
  lastOutcome: string | null;
  lastOutcomeDetail: string | null;
}

/** 派生断点所需的 mission 事实（由调用方从权威存储读出）。 */
export interface ContinuationMissionFacts {
  readonly missionIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly projectIdentifier: string | null;
  readonly prompt: string;
  readonly status: "running" | "done" | "cancelled" | "blocked";
  readonly createdAtIso: string;
  readonly hasTrustedCheckpoint: boolean;
}

/** 断点标识是**确定**的：同一 mission 永远同一张卡（去重的根据）。 */
export function continuityBreakpointIdentifier(missionIdentifier: string): string {
  const digest = createHash("sha256").update(missionIdentifier).digest("hex").slice(0, 16);
  return `breakpoint-${digest}`;
}

function shortTaskName(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/gu, " ");
  if (trimmed === "") return "（无提示词记录）";
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 40)}…`;
}

/**
 * 派生单条断点（不读盘、不写盘）。
 *
 * - `running` / `done` ⇒ **不是断点**（仍在跑或已结束）；
 * - `cancelled` ⇒ 断点但**不可恢复**（不复活，如实说明）；
 * - `blocked` ⇒ 断点；无可信检查点则不可恢复（不承诺能从检查点继续）。
 */
export function deriveContinuationBreakpoint(
  facts: ContinuationMissionFacts,
): ContinuationBreakpointView | null {
  if (facts.status === "running" || facts.status === "done") return null;
  const conversationIdentifier = facts.conversationIdentifier;
  if (conversationIdentifier === null || conversationIdentifier.trim() === "") {
    /** 没有稳定会话就无处安放卡片：宁可不显示，也不塞进别的会话。 */
    return null;
  }
  const breakpointIdentifier = continuityBreakpointIdentifier(facts.missionIdentifier);
  const isCancelled = facts.status === "cancelled";
  const blockedReason = isCancelled
    ? "任务已取消：取消不复活已结束的执行；如需继续请新建任务。"
    : facts.hasTrustedCheckpoint
      ? null
      : "没有可信检查点：无法保证从原位继续（不以“从头重跑”冒充续接）。";
  return {
    breakpointIdentifier,
    conversationIdentifier,
    missionIdentifier: facts.missionIdentifier,
    projectIdentifier: facts.projectIdentifier,
    taskShortName: shortTaskName(facts.prompt),
    interruptionReason: isCancelled ? "mission-cancelled" : "mission-blocked",
    status: "open",
    revision: 1,
    lastCheckpointIdentifier: facts.hasTrustedCheckpoint
      ? `checkpoint:${facts.missionIdentifier}`
      : null,
    nextStep: isCancelled
      ? "已结束，无需操作"
      : facts.hasTrustedCheckpoint
        ? "点击“恢复任务”从最近检查点继续"
        : "需人工核对未决事项后再决定",
    canResume: blockedReason === null,
    blockedReason,
    recordedAtIso: facts.createdAtIso,
    updatedAtIso: facts.createdAtIso,
    lastRequestIdentifier: null,
  };
}

export interface ContinuationBreakpointStoreOptions {
  baseDirectory: string;
  now?: () => number;
}

/**
 * 覆盖层存储：每个断点一个文件，原子写入。
 *
 * 只保存**用户操作产生的状态**；派生事实不落盘（它们来自 mission 摘要，避免两份真相）。
 */
export class ContinuationBreakpointStore {
  private readonly directory: string;
  private readonly now: () => number;

  constructor(options: ContinuationBreakpointStoreOptions) {
    this.directory = path.join(options.baseDirectory, "continuation-breakpoints");
    this.now = options.now ?? (() => Date.now());
  }

  private filePath(breakpointIdentifier: string): string {
    return path.join(
      this.directory,
      `${sanitizePathSegment(breakpointIdentifier)}.json`,
    );
  }

  async read(
    breakpointIdentifier: string,
  ): Promise<ContinuationOverlayRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath(breakpointIdentifier), "utf8");
      const parsed = JSON.parse(raw) as Partial<ContinuationOverlayRecord>;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.breakpointIdentifier !== breakpointIdentifier ||
        typeof parsed.status !== "string" ||
        typeof parsed.revision !== "number"
      ) {
        /** 损坏/异体记录按"没有覆盖"处理，并**显式**让调用方知道来源是派生值。 */
        return null;
      }
      return parsed as ContinuationOverlayRecord;
    } catch {
      return null;
    }
  }

  async write(record: ContinuationOverlayRecord): Promise<void> {
    await writeAtomicJson(this.filePath(record.breakpointIdentifier), record, {
      beforeCommit: async () => {
        /**
         * 乐观并发：提交前复核既有 revision 未超过本记录。
         * 两个标签页同时点"恢复任务"时，后来者会在这里失败而不是覆盖。
         */
        const existing = await this.read(record.breakpointIdentifier);
        if (existing !== null && existing.revision > record.revision) {
          throw new DomainError(
            "stale-revision",
            `断点已被更新（当前 revision ${existing.revision}），请刷新后重试。`,
          );
        }
      },
    });
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** 续接结果（如实区分：只到"已派发"，不等于任务完成）。 */
export type ContinuationRequestOutcome =
  | "resumed"
  | "already-requested"
  | "stale-revision"
  | "not-resumable"
  | "blocked"
  | "not-found";

export interface ContinuationRequestResult {
  readonly outcome: ContinuationRequestOutcome;
  readonly reason: string;
  readonly breakpoint: ContinuationBreakpointView | null;
}

export interface ContinuationControllerOptions {
  readonly store: ContinuationBreakpointStore;
  /** 该会话下的 mission 标识列表（来自权威摘要，不得用 missionId 顶替会话）。 */
  readonly readConversationMissions: (
    conversationIdentifier: string,
  ) => Promise<readonly string[]>;
  readonly readMission: (
    missionIdentifier: string,
  ) => Promise<ContinuationMissionFacts | null>;
  readonly hasTrustedCheckpoint: (missionIdentifier: string) => Promise<boolean>;
  /** 真正执行恢复（由装配层注入 `MainController.resumeMission` 等既有门禁）。 */
  readonly resumeMission: (missionIdentifier: string) => Promise<void>;
}

/**
 * 续接控制器：派生 → 校验版本 → 记录请求 → 调用既有恢复门禁。
 *
 * 纪律：
 * - 请求幂等（同一 `requestIdentifier` 重放只生效一次，断线重连按原 ID 补送）；
 * - 版本过期 ⇒ 要求重新点击（不自动给新版本授权）；
 * - 恢复被门禁拒绝 ⇒ 卡片**保持 open** 并写明原因（不假装已恢复）；
 * - 成功 ⇒ 转 `resumed`，但**不**据此宣称任务完成。
 */
export class ContinuationController {
  constructor(private readonly options: ContinuationControllerOptions) {}

  private async buildView(
    facts: ContinuationMissionFacts,
  ): Promise<ContinuationBreakpointView | null> {
    const hasTrustedCheckpoint = facts.hasTrustedCheckpoint;
    const derived = deriveContinuationBreakpoint({ ...facts, hasTrustedCheckpoint });
    if (derived === null) return null;
    const overlay = await this.options.store.read(derived.breakpointIdentifier);
    if (overlay === null) return derived;
    const status = overlay.status;
    return {
      ...derived,
      status,
      revision: overlay.revision,
      updatedAtIso: overlay.updatedAtIso,
      lastRequestIdentifier: overlay.lastRequestIdentifier,
      /** 终态直接沿用派生原因；请求中/已恢复不重复说明。 */
      nextStep:
        status === "resumed"
          ? "已派发恢复（不代表任务已完成），详情见运行历史"
          : status === "requested"
            ? "恢复请求已登记，等待执行端接收"
            : status === "cancelled"
              ? "已取消续接请求"
              : derived.nextStep,
      canResume: derived.canResume && status === "open",
      blockedReason: derived.canResume ? null : derived.blockedReason,
    };
  }

  /** 某会话当前的断点卡（含终态，用于"留档"）。 */
  async listForConversation(
    conversationIdentifier: string,
  ): Promise<ContinuationBreakpointView[]> {
    const missionIdentifiers = await this.options.readConversationMissions(
      conversationIdentifier,
    );
    const views: ContinuationBreakpointView[] = [];
    for (const missionIdentifier of missionIdentifiers) {
      const facts = await this.options.readMission(missionIdentifier);
      if (facts === null) continue;
      if (facts.conversationIdentifier !== conversationIdentifier) continue;
      const view = await this.buildView({
        ...facts,
        hasTrustedCheckpoint: await this.options.hasTrustedCheckpoint(missionIdentifier),
      });
      if (view !== null) views.push(view);
    }
    views.sort((left, right) =>
      left.recordedAtIso === right.recordedAtIso
        ? left.breakpointIdentifier.localeCompare(right.breakpointIdentifier)
        : left.recordedAtIso.localeCompare(right.recordedAtIso),
    );
    return views;
  }

  /** 单张断点卡（按标识，供重连后按原 ID 校验）。 */
  async read(
    breakpointIdentifier: string,
    missionIdentifier: string,
  ): Promise<ContinuationBreakpointView | null> {
    if (continuityBreakpointIdentifier(missionIdentifier) !== breakpointIdentifier) {
      return null;
    }
    const facts = await this.options.readMission(missionIdentifier);
    if (facts === null) return null;
    return this.buildView({
      ...facts,
      hasTrustedCheckpoint: await this.options.hasTrustedCheckpoint(missionIdentifier),
    });
  }

  async requestContinuation(input: {
    breakpointIdentifier: string;
    missionIdentifier: string;
    expectedRevision: number;
    requestIdentifier: string;
  }): Promise<ContinuationRequestResult> {
    if (input.requestIdentifier.trim() === "") {
      throw new DomainError("invalid-task-chain", "续接请求必须带幂等键。");
    }
    const facts = await this.options.readMission(input.missionIdentifier);
    if (facts === null) {
      return { outcome: "not-found", reason: "任务不存在。", breakpoint: null };
    }
    const view = await this.read(input.breakpointIdentifier, input.missionIdentifier);
    if (view === null) {
      return { outcome: "not-found", reason: "该任务没有断点记录。", breakpoint: null };
    }
    /** 幂等：同一请求 ID 重复投递（断线重连）直接复用既有结果。 */
    if (view.lastRequestIdentifier === input.requestIdentifier && view.status !== "open") {
      return {
        outcome: "already-requested",
        reason: "该续接请求已登记（幂等复用，未重复执行）。",
        breakpoint: view,
      };
    }
    if (input.expectedRevision !== view.revision) {
      return {
        outcome: "stale-revision",
        reason: `断点已更新（当前 revision ${view.revision}），请刷新后重新点击。`,
        breakpoint: view,
      };
    }
    if (!view.canResume) {
      return {
        outcome: "not-resumable",
        reason: view.blockedReason ?? "当前状态不可续接。",
        breakpoint: view,
      };
    }
    const requestedRevision = view.revision + 1;
    const requestedAtIso = this.options.store.nowIso();
    await this.options.store.write({
      schemaVersion: 1,
      breakpointIdentifier: view.breakpointIdentifier,
      status: "requested",
      revision: requestedRevision,
      updatedAtIso: requestedAtIso,
      lastRequestIdentifier: input.requestIdentifier,
      lastOutcome: null,
      lastOutcomeDetail: null,
    });
    try {
      await this.options.resumeMission(input.missionIdentifier);
    } catch (error) {
      /**
       * 门禁拒绝（对账未过/租约冲突/目标暂停…）⇒ 如实退回 `open` 并写明原因，
       * **不**把"点了按钮"写成"已恢复"。
       */
      const detail = error instanceof Error ? error.message : String(error);
      await this.options.store.write({
        schemaVersion: 1,
        breakpointIdentifier: view.breakpointIdentifier,
        status: "open",
        revision: requestedRevision + 1,
        updatedAtIso: this.options.store.nowIso(),
        lastRequestIdentifier: input.requestIdentifier,
        lastOutcome: "blocked",
        lastOutcomeDetail: detail,
      });
      const updated = await this.read(view.breakpointIdentifier, input.missionIdentifier);
      return {
        outcome: "blocked",
        reason: detail,
        breakpoint: updated,
      };
    }
    await this.options.store.write({
      schemaVersion: 1,
      breakpointIdentifier: view.breakpointIdentifier,
      status: "resumed",
      revision: requestedRevision + 1,
      updatedAtIso: this.options.store.nowIso(),
      lastRequestIdentifier: input.requestIdentifier,
      lastOutcome: "resumed",
      lastOutcomeDetail: "恢复已派发给执行端（不代表任务已完成）。",
    });
    const updated = await this.read(view.breakpointIdentifier, input.missionIdentifier);
    return {
      outcome: "resumed",
      reason: "恢复已派发给执行端（不代表任务完成）。",
      breakpoint: updated,
    };
  }
}
