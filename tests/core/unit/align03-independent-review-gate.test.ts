/**
 * ALIGN-03-01：**独立审查门禁**（此前 `tests/` 下零引用，属"谁有权签字"的安全判定）。
 *
 * 卡内三条要求逐条锁死：
 * ① 验收者必须是**任命次级的直属三级**（不得跨次级借人/跨 mission 借人）；
 * ② **自报不是证据**——只有 `self-report:` / `executor-report:` / `agent-claim:` 前缀 ⇒ 拒绝；
 * ③ 纵深防御：实现者/测试者不得给自己签发验收结论。
 */
import { describe, expect, it } from "vitest";

import { AgentAppointmentRegistry } from "../../../packages/core/src/orchestration/agent-appointment-registry.js";
import {
  IndependentReviewGate,
  isOnlySelfReportedEvidence,
} from "../../../packages/core/src/orchestration/independent-review-gate.js";

interface RecordedVerdict {
  appointmentId: string;
  verdict: { acceptingAgentInstanceId: string; verdict: string; reason: string };
}

interface RegistryEntry {
  agentInstanceId: string;
  agentRole: string;
  missionId: string;
  owningSecondaryAgentInstanceId: string;
}

function buildGate(options: {
  directoryEntries?: Record<string, RegistryEntry>;
  recordedVerdicts?: RecordedVerdict[];
  savedVerdicts?: unknown[];
} = {}) {
  const recordedVerdicts = options.recordedVerdicts ?? [];
  const savedVerdicts = options.savedVerdicts ?? [];
  const directoryEntries = options.directoryEntries ?? {
    "tertiary-accept": {
      agentInstanceId: "tertiary-accept",
      agentRole: "tertiary",
      missionId: "mission-1",
      owningSecondaryAgentInstanceId: "secondary-1",
    },
  };
  const gate = new IndependentReviewGate({
    appointmentRegistry: new AgentAppointmentRegistry(),
    acceptanceVerdictGate: {
      recordVerdict: async (input: RecordedVerdict) => {
        recordedVerdicts.push(input);
      },
      evaluateMergeReadiness: () => ({ isMergeReady: false, reasons: ["stub"] }),
    } as never,
    registeredAgentDirectory: {
      getAgentEntry: (agentInstanceId: string) => directoryEntries[agentInstanceId] ?? null,
    } as never,
    completionVerdictStore: {
      save: async (record: unknown) => {
        savedVerdicts.push(record);
      },
    } as never,
  });
  return { gate, recordedVerdicts, savedVerdicts };
}

function appointmentInput(overrides: Record<string, unknown> = {}) {
  return {
    appointmentIdentifier: "appointment-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    taskRevision: 1,
    riskLevel: "low",
    appointingSecondaryAgentInstanceIdentifier: "secondary-1",
    implementationAgentInstanceIdentifier: "tertiary-impl",
    testingAgentInstanceIdentifier: "tertiary-test",
    acceptanceAgentInstanceIdentifier: "tertiary-accept",
    ...overrides,
  } as never;
}

function verdictInput(overrides: Record<string, unknown> = {}) {
  return {
    appointmentIdentifier: "appointment-1",
    verdict: {
      acceptingAgentInstanceIdentifier: "tertiary-accept",
      boundTaskIdentifier: "T-001",
      boundTaskRevision: 1,
      boundCommitHash: "abc123",
      verdict: "merge-ready",
      evidenceReferences: ["git:abc123"],
      reason: "已核对产物与提交",
      ...((overrides["verdict"] as Record<string, unknown>) ?? {}),
    },
  } as never;
}

describe("自报证据判定", () => {
  it("① 空证据或全自报 ⇒ 视为「只有自报」；混入外部证据 ⇒ 不算", () => {
    expect(isOnlySelfReportedEvidence([])).toBe(true);
    expect(isOnlySelfReportedEvidence(["self-report:done"])).toBe(true);
    expect(isOnlySelfReportedEvidence(["executor-report:ok", "agent-claim:fine"])).toBe(true);
    expect(isOnlySelfReportedEvidence(["SELF-REPORT:Done"])).toBe(true);
    expect(isOnlySelfReportedEvidence(["self-report:done", "test-output:12 passed"])).toBe(false);
  });
});

describe("任命校验（直属上级）", () => {
  it("② 任命者自己签字 ⇒ 拒绝", () => {
    const { gate } = buildGate();
    expect(() =>
      gate.appoint(appointmentInput({ acceptanceAgentInstanceIdentifier: "secondary-1" })),
    ).toThrow(/自审被拒/u);
  });

  it("③ 验收者未登记 ⇒ 拒绝（非空字符串不是认证）", () => {
    const { gate } = buildGate();
    expect(() =>
      gate.appoint(appointmentInput({ acceptanceAgentInstanceIdentifier: "ghost" })),
    ).toThrow(/未登记/u);
  });

  it("④ 验收者不属于任命次级 ⇒ 拒绝（不得借人来签字）", () => {
    const { gate } = buildGate({
      directoryEntries: {
        "tertiary-other": {
          agentInstanceId: "tertiary-other",
          agentRole: "tertiary",
          missionId: "mission-1",
          owningSecondaryAgentInstanceId: "secondary-OTHER",
        },
      },
    });
    expect(() =>
      gate.appoint(appointmentInput({ acceptanceAgentInstanceIdentifier: "tertiary-other" })),
    ).toThrow(/直属于任命次级/u);
  });

  it("⑤ 验收者不是三级个体 ⇒ 拒绝", () => {
    const { gate } = buildGate({
      directoryEntries: {
        "secondary-accept": {
          agentInstanceId: "secondary-accept",
          agentRole: "secondary",
          missionId: "mission-1",
          owningSecondaryAgentInstanceId: "secondary-1",
        },
      },
    });
    expect(() =>
      gate.appoint(appointmentInput({ acceptanceAgentInstanceIdentifier: "secondary-accept" })),
    ).toThrow(/必须是三级个体/u);
  });
});

describe("裁决校验（独立性与证据）", () => {
  it("⑥ 实现者或测试者自签 ⇒ 拒绝", async () => {
    const { gate } = buildGate();
    gate.appoint(appointmentInput());
    for (const selfSigner of ["tertiary-impl", "tertiary-test"]) {
      await expect(
        gate.recordVerdict(
          verdictInput({ verdict: { acceptingAgentInstanceIdentifier: selfSigner } }),
        ),
      ).rejects.toThrow(/不能给自己的任务签发验收结论/u);
    }
  });

  it("⑦ 只有执行者自报的证据 ⇒ 拒绝", async () => {
    const { gate } = buildGate();
    gate.appoint(appointmentInput());
    await expect(
      gate.recordVerdict(
        verdictInput({ verdict: { evidenceReferences: ["self-report:全部完成"] } }),
      ),
    ).rejects.toThrow(/自报不能代替独立审查结论/u);
  });

  it("⑧ 理由空白 ⇒ 拒绝", async () => {
    const { gate } = buildGate();
    gate.appoint(appointmentInput());
    await expect(gate.recordVerdict(verdictInput({ verdict: { reason: "   " } }))).rejects.toThrow(
      /必须写明理由/u,
    );
  });

  it("⑨ 合法裁决 ⇒ 通过门禁并落盘（merge-ready ⇒ accepted）", async () => {
    const recordedVerdicts: RecordedVerdict[] = [];
    const savedVerdicts: unknown[] = [];
    const { gate } = buildGate({ recordedVerdicts, savedVerdicts });
    gate.appoint(appointmentInput());
    await gate.recordVerdict(verdictInput());
    expect(recordedVerdicts).toHaveLength(1);
    expect(savedVerdicts).toHaveLength(1);
    expect((savedVerdicts[0] as { verdict: string }).verdict).toBe("accepted");
  });
});
