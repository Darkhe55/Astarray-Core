/**
 * ALIGN-03-01（2026-10-28）：**独立审查门禁**。
 *
 * 卡内要求：次级任命**执行与测试/审查的具体下级**；同一执行任务的**自报不能代替
 * 独立审查结论**；执行者只完成被分配任务链并向**唯一直属上级**报告。
 *
 * 既有组件（`AgentAppointmentRegistry` / `AcceptanceVerdictGate`）已能校验
 * "实现者不得自验、高风险三身份互异、裁决绑定 revision 与提交哈希"。本模块补三处缺口：
 *
 * 1. **直属上级校验**：验收者必须是**本次任命者**名下的三级个体
 *    （`RegisteredAgentDirectory.owningSecondaryAgentInstanceId === 任命次级`），
 *    否则等于让别家的下级来签字；
 * 2. **自报不是证据**：裁决的证据引用里只要**全部**是执行者的自报
 *    （`self-report:` / `executor-report:` 前缀），就拒绝 —— 必须至少有一条
 *    外部可核对证据（工具结果、提交哈希、测试输出等）；
 * 3. **纵深防御**：即使任命数据被绕过，裁决者也不得等于实现者或测试者。
 *
 * 本模块不派发任务、不写任务链：它只保证"谁有权任命、谁有权签字、拿什么签字"。
 */
import { DomainError } from "../core/errors.js";
import type { AcceptanceVerdictGate } from "./acceptance-verdict-gate.js";
import type { AgentAppointmentRegistry, AppointmentRiskLevel } from "./agent-appointment-registry.js";
import type { RegisteredAgentDirectory } from "./registered-agent-directory.js";

/** 被视为"执行者自报"的证据前缀（不构成独立审查证据）。 */
const SELF_REPORT_EVIDENCE_PREFIXES = [
  "self-report:",
  "executor-report:",
  "agent-claim:",
] as const;

export interface AppointIndependentReviewInput {
  readonly appointmentIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly taskRevision: number;
  readonly riskLevel: AppointmentRiskLevel;
  /** 任命方（具体次级个体）。 */
  readonly appointingSecondaryAgentInstanceIdentifier: string;
  readonly implementationAgentInstanceIdentifier: string;
  readonly testingAgentInstanceIdentifier: string;
  readonly acceptanceAgentInstanceIdentifier: string;
  readonly allowsSharedTestAndAcceptance?: boolean;
}

export interface RecordIndependentVerdictInput {
  readonly appointmentIdentifier: string;
  readonly verdict: {
    readonly acceptingAgentInstanceIdentifier: string;
    readonly boundTaskIdentifier: string;
    readonly boundTaskRevision: number;
    readonly boundCommitHash: string | null;
    readonly verdict: "rework" | "merge-ready" | "blocked-human-review";
    readonly evidenceReferences: readonly string[];
    /** 裁决理由（非空；不是执行者自报内容）。 */
    readonly reason: string;
    readonly createdAtIso?: string;
  };
}

/** 证据是否为"只有执行者自报"（自报不能代替独立审查结论）。 */
export function isOnlySelfReportedEvidence(
  evidenceReferences: readonly string[],
): boolean {
  if (evidenceReferences.length === 0) {
    return true;
  }
  return evidenceReferences.every((reference) =>
    SELF_REPORT_EVIDENCE_PREFIXES.some((prefix) =>
      reference.trim().toLowerCase().startsWith(prefix),
    ),
  );
}

export class IndependentReviewGate {
  private readonly appointmentRegistry: AgentAppointmentRegistry;
  private readonly acceptanceVerdictGate: AcceptanceVerdictGate;
  private readonly registeredAgentDirectory: RegisteredAgentDirectory | null;

  constructor(options: {
    appointmentRegistry: AgentAppointmentRegistry;
    acceptanceVerdictGate: AcceptanceVerdictGate;
    registeredAgentDirectory?: RegisteredAgentDirectory | null;
  }) {
    this.appointmentRegistry = options.appointmentRegistry;
    this.acceptanceVerdictGate = options.acceptanceVerdictGate;
    this.registeredAgentDirectory = options.registeredAgentDirectory ?? null;
  }

  /**
   * 任命实现/测试/验收三者，并校验**验收者的直属上级就是任命次级**。
   *
   * 身份隔离规则仍由 `AgentAppointmentRegistry` 判定（不重复实现）；
   * 这里额外拒绝"跨次级借人来签字"与"任命者自己签字"。
   */
  appoint(input: AppointIndependentReviewInput): void {
    if (
      input.acceptanceAgentInstanceIdentifier ===
      input.appointingSecondaryAgentInstanceIdentifier
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "任命者不能同时担任该任务的验收者（自审被拒）。",
      );
    }
    const directory = this.registeredAgentDirectory;
    if (directory !== null) {
      const acceptanceEntry = directory.getAgentEntry(
        input.acceptanceAgentInstanceIdentifier,
      );
      if (acceptanceEntry === null) {
        throw new DomainError(
          "task-sequence-permission-denied",
          `验收者未登记（非空字符串不是认证）: ${input.acceptanceAgentInstanceIdentifier}`,
        );
      }
      if (acceptanceEntry.agentRole !== "tertiary") {
        throw new DomainError(
          "task-sequence-permission-denied",
          `验收者必须是三级个体（当前 ${acceptanceEntry.agentRole}）`,
        );
      }
      if (acceptanceEntry.missionId !== input.missionIdentifier) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "验收者登记的 mission 与本次任命不一致（不得跨 mission 借人签字）",
        );
      }
      if (
        acceptanceEntry.owningSecondaryAgentInstanceId !==
        input.appointingSecondaryAgentInstanceIdentifier
      ) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "验收者必须直属于任命次级（执行者/审查者只对唯一直属上级负责）",
        );
      }
    }
    this.appointmentRegistry.createAppointment({
      appointmentId: input.appointmentIdentifier,
      boundTaskIdentifier: input.taskIdentifier,
      boundTaskRevision: input.taskRevision,
      appointingSecondaryAgentInstanceId:
        input.appointingSecondaryAgentInstanceIdentifier,
      riskLevel: input.riskLevel,
      implementationAgentInstanceId: input.implementationAgentInstanceIdentifier,
      testingAgentInstanceId: input.testingAgentInstanceIdentifier,
      acceptanceAgentInstanceId: input.acceptanceAgentInstanceIdentifier,
      ...(input.allowsSharedTestAndAcceptance === undefined
        ? {}
        : { allowsSharedTestAndAcceptance: input.allowsSharedTestAndAcceptance }),
    });
  }

  /**
   * 记录独立验收裁决。
   *
   * 三层拒绝：① 裁决者必须是任命的验收者（既有门禁）；② 裁决者不得等于实现/测试者
   * （纵深防御）；③ **只有执行者自报的证据不算独立审查**。
   */
  async recordVerdict(input: RecordIndependentVerdictInput): Promise<void> {
    const appointment = this.appointmentRegistry.getAppointment(
      input.appointmentIdentifier,
    );
    if (appointment === null) {
      throw new DomainError(
        "dependency-not-found",
        `任命不存在: ${input.appointmentIdentifier}`,
      );
    }
    const acceptingAgentInstanceIdentifier =
      input.verdict.acceptingAgentInstanceIdentifier;
    if (
      acceptingAgentInstanceIdentifier ===
        appointment.implementationAgentInstanceId ||
      acceptingAgentInstanceIdentifier === appointment.testingAgentInstanceId
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "实现者或测试者不能给自己的任务签发验收结论（独立审查被拒）。",
      );
    }
    if (isOnlySelfReportedEvidence(input.verdict.evidenceReferences)) {
      throw new DomainError(
        "invalid-task-chain",
        "验收证据只有执行者自报：自报不能代替独立审查结论，请附外部可核对的证据引用。",
      );
    }
    if (input.verdict.reason.trim() === "") {
      throw new DomainError("invalid-task-chain", "验收裁决必须写明理由（不得空白）。");
    }
    await this.acceptanceVerdictGate.recordVerdict({
      appointmentId: input.appointmentIdentifier,
      verdict: {
        acceptingAgentInstanceId: acceptingAgentInstanceIdentifier,
        boundTaskIdentifier: input.verdict.boundTaskIdentifier,
        boundTaskRevision: input.verdict.boundTaskRevision,
        boundCommitHash: input.verdict.boundCommitHash,
        verdict: input.verdict.verdict,
        reason: input.verdict.reason.trim(),
        evidenceReferences: [...input.verdict.evidenceReferences],
        createdAtIso: input.verdict.createdAtIso ?? new Date().toISOString(),
      },
    });
  }

  /** 合并就绪评估（委托既有门禁；不在这里重复判定规则）。 */
  evaluateMergeReadiness(input: Parameters<AcceptanceVerdictGate["evaluateMergeReadiness"]>[0]) {
    return this.acceptanceVerdictGate.evaluateMergeReadiness(input);
  }
}
