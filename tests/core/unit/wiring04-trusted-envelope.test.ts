/**
 * WIRING-04-03 补口（2026-11-25）：受信信封盖章的反例。
 */
import { describe, expect, it } from "vitest";

import {
  sealTrustedFeedbackEnvelope,
  type TrustedExecutionRegistration,
} from "../../../packages/core/src/orchestration/trusted-feedback-envelope.js";

const registration: TrustedExecutionRegistration = {
  sourceAgentInstanceIdentifier: "agent-1",
  projectIdentifier: "project-a",
  missionIdentifier: "mission-1",
  taskIdentifier: "T-1",
  taskRevision: 3,
  executionAttempt: 2,
};

describe("WIRING-04-03 受信信封盖章", () => {
  it("① 载荷没有自报字段 ⇒ 信封完全取自登记", () => {
    const result = sealTrustedFeedbackEnvelope({ registration });
    expect(result).toEqual({
      kind: "sealed",
      envelope: {
        sourceAgentInstanceIdentifier: "agent-1",
        projectIdentifier: "project-a",
        taskIdentifier: "T-1",
        taskRevision: 3,
        executionAttempt: 2,
      },
    });
  });

  it("② 自报来源与登记不一致 ⇒ 拒绝（不以载荷为准）", () => {
    const result = sealTrustedFeedbackEnvelope({
      registration,
      draftClaims: { sourceAgentInstanceIdentifier: "agent-999" },
    });
    expect(result).toMatchObject({ kind: "rejected", reasonCode: "draft-claims-mismatch" });
  });

  it("③ 自报 taskRevision/executionAttempt 不一致 ⇒ 拒绝（防旧 attempt 冒充）", () => {
    expect(
      sealTrustedFeedbackEnvelope({
        registration,
        draftClaims: { taskRevision: 2 },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "draft-claims-mismatch" });
    expect(
      sealTrustedFeedbackEnvelope({
        registration,
        draftClaims: { executionAttempt: 1 },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "draft-claims-mismatch" });
  });

  it("④ 自报项目不一致 ⇒ 拒绝（防串项目）", () => {
    expect(
      sealTrustedFeedbackEnvelope({
        registration,
        draftClaims: { projectIdentifier: "project-b" },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "draft-claims-mismatch" });
  });

  it("⑤ 登记缺 taskRevision/executionAttempt ⇒ 拒绝，不补默认值", () => {
    expect(
      sealTrustedFeedbackEnvelope({
        registration: { ...registration, taskRevision: null },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "registration-incomplete" });
    expect(
      sealTrustedFeedbackEnvelope({
        registration: { ...registration, executionAttempt: 0 },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "registration-incomplete" });
  });

  it("⑥ 自报字段与登记一致 ⇒ 允许（核对通过，但仍以登记值为准）", () => {
    const result = sealTrustedFeedbackEnvelope({
      registration,
      draftClaims: {
        sourceAgentInstanceIdentifier: "agent-1",
        projectIdentifier: "project-a",
        taskRevision: 3,
        executionAttempt: 2,
      },
    });
    expect(result.kind).toBe("sealed");
  });
});
