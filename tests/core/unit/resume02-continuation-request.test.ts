/**
 * RESUME-02 首版测试（2026-11-24）：配置默认关闭、状态推导、回执有效期与复核。
 *
 * 关键反例：普通"继续"没有入口（只接受结构化请求）；未指定目标不猜最近任务；
 * 运行中不重复派发；完成后不复活；旧回执不能换新许可。
 */
import { describe, expect, it } from "vitest";

import {
  RESUME_INTENT_RECEIPT_VALIDITY_MILLISECONDS,
  evaluateContinuationRequest,
  issueResumeIntentReceipt,
  resolveCheckpointContinuationSetting,
  validateResumeIntentReceipt,
  type ContinuationCandidate,
  type StructuredContinuationRequest,
} from "../../../packages/core/src/orchestration/continuation-request.js";

const enabled = resolveCheckpointContinuationSetting({ configuredValue: true });

function candidate(overrides: Partial<ContinuationCandidate> = {}): ContinuationCandidate {
  return {
    taskIdentifier: "T-1",
    projectIdentifier: "project-a",
    taskState: "planned",
    revision: 3,
    ...overrides,
  };
}

function request(overrides: Partial<StructuredContinuationRequest> = {}): StructuredContinuationRequest {
  return {
    requestIdentifier: "req-1",
    projectIdentifier: "project-a",
    conversationIdentifier: "conv-1",
    taskIdentifier: "T-1",
    expectedRevision: 3,
    ...overrides,
  };
}

describe("RESUME-02：配置默认关闭", () => {
  it("① 缺失/非布尔/false ⇒ 关闭；只有显式 true 才开启", () => {
    expect(resolveCheckpointContinuationSetting({ configuredValue: undefined })).toEqual({
      isEnabled: false,
      reason: "config-missing",
    });
    expect(resolveCheckpointContinuationSetting({ configuredValue: "true" })).toEqual({
      isEnabled: false,
      reason: "config-invalid",
    });
    expect(resolveCheckpointContinuationSetting({ configuredValue: false }).isEnabled).toBe(false);
    expect(resolveCheckpointContinuationSetting({ configuredValue: true })).toEqual({
      isEnabled: true,
      reason: "enabled",
    });
  });

  it("② 关闭时一律 disabled（不影响既有恢复入口，本层只给判定）", () => {
    const evaluation = evaluateContinuationRequest({
      setting: resolveCheckpointContinuationSetting({ configuredValue: false }),
      request: request(),
      candidates: [candidate()],
    });
    expect(evaluation.status).toBe("disabled");
  });
});

describe("RESUME-02：状态由本地权威记录推导", () => {
  it("③ 未指定目标 ⇒ needs-selection 并列出候选（不擅自选最近）", () => {
    const evaluation = evaluateContinuationRequest({
      setting: enabled,
      request: null,
      candidates: [candidate(), candidate({ taskIdentifier: "T-2" })],
    });
    expect(evaluation.status).toBe("needs-selection");
    expect(evaluation.candidateTaskIdentifiers).toEqual(["T-1", "T-2"]);
  });

  it("④ 跨项目候选不算（按项目作用域过滤）", () => {
    const evaluation = evaluateContinuationRequest({
      setting: enabled,
      request: request({ projectIdentifier: "project-b" }),
      candidates: [candidate()],
    });
    expect(evaluation.status).toBe("nothing-to-resume");
  });

  it("⑤ 目标不存在/版本变化 ⇒ 不恢复（needs-selection / reconciling）", () => {
    const missing = evaluateContinuationRequest({
      setting: enabled,
      request: request({ taskIdentifier: "T-9" }),
      candidates: [candidate()],
    });
    expect(missing.status).toBe("needs-selection");
    const stale = evaluateContinuationRequest({
      setting: enabled,
      request: request({ expectedRevision: 2 }),
      candidates: [candidate()],
    });
    expect(stale).toEqual({
      status: "reconciling",
      reasonCode: "revision-changed",
      candidateTaskIdentifiers: ["T-1"],
    });
  });

  it("⑥ 运行中 ⇒ still-running（不重复派发）", () => {
    expect(
      evaluateContinuationRequest({
        setting: enabled,
        request: request(),
        candidates: [candidate({ taskState: "running" })],
      }).status,
    ).toBe("still-running");
  });

  it("⑦ 待回答/待授权/人工暂停 各自区分（「继续」都不等于答案或授权）", () => {
    const statusFor = (taskState: ContinuationCandidate["taskState"]) =>
      evaluateContinuationRequest({
        setting: enabled,
        request: request(),
        candidates: [candidate({ taskState })],
      }).status;
    expect(statusFor("awaiting-answer")).toBe("needs-answer");
    expect(statusFor("awaiting-authorization")).toBe("needs-authorization");
    expect(statusFor("paused")).toBe("paused");
  });

  it("⑧ 已完成/已取消 ⇒ 不复活；未知在途 ⇒ reconciling", () => {
    const statusFor = (taskState: ContinuationCandidate["taskState"]) =>
      evaluateContinuationRequest({
        setting: enabled,
        request: request(),
        candidates: [candidate({ taskState })],
      }).status;
    expect(statusFor("completed")).toBe("completed");
    expect(statusFor("cancelled")).toBe("cancelled");
    expect(statusFor("started-unknown")).toBe("reconciling");
  });

  it("⑨ planned 且版本一致 ⇒ resumable（检查点确认未执行）", () => {
    expect(
      evaluateContinuationRequest({
        setting: enabled,
        request: request(),
        candidates: [candidate({ taskState: "planned" })],
      }),
    ).toEqual({
      status: "resumable",
      reasonCode: "checkpoint-confirmed-not-executed",
      candidateTaskIdentifiers: ["T-1"],
    });
  });
});

describe("RESUME-02：回执有效期与复核", () => {
  it("⑩ 回执 5 分钟有效；过期即拒绝", () => {
    const receipt = issueResumeIntentReceipt({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso: "2026-11-24T00:00:00.000Z",
    });
    expect(receipt.expiresAtIso).toBe(
      new Date(
        Date.parse("2026-11-24T00:00:00.000Z") + RESUME_INTENT_RECEIPT_VALIDITY_MILLISECONDS,
      ).toISOString(),
    );
    expect(
      validateResumeIntentReceipt({
        receipt,
        principalIdentifier: "user-1",
        taskIdentifier: "T-1",
        expectedRevision: 3,
        nowIso: "2026-11-24T00:04:59.000Z",
      }),
    ).toEqual({ isValid: true, reasonCode: null });
    expect(
      validateResumeIntentReceipt({
        receipt,
        principalIdentifier: "user-1",
        taskIdentifier: "T-1",
        expectedRevision: 3,
        nowIso: "2026-11-24T00:05:00.000Z",
      }),
    ).toEqual({ isValid: false, reasonCode: "receipt-expired" });
  });

  it("⑪ 主体/目标/版本不一致 ⇒ 拒绝（旧回执不换新许可）", () => {
    const receipt = issueResumeIntentReceipt({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso: "2026-11-24T00:00:00.000Z",
    });
    const base = {
      receipt,
      principalIdentifier: "user-1",
      taskIdentifier: "T-1",
      expectedRevision: 3,
      nowIso: "2026-11-24T00:01:00.000Z",
    };
    expect(validateResumeIntentReceipt({ ...base, principalIdentifier: "user-2" }).reasonCode).toBe(
      "principal-mismatch",
    );
    expect(validateResumeIntentReceipt({ ...base, taskIdentifier: "T-2" }).reasonCode).toBe(
      "target-mismatch",
    );
    expect(validateResumeIntentReceipt({ ...base, expectedRevision: 4 }).reasonCode).toBe(
      "revision-changed",
    );
  });

  it("⑫ 非法时间 ⇒ 拒绝（不把坏数据当有效）", () => {
    const receipt = issueResumeIntentReceipt({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso: "2026-11-24T00:00:00.000Z",
    });
    expect(
      validateResumeIntentReceipt({
        receipt,
        principalIdentifier: "user-1",
        taskIdentifier: "T-1",
        expectedRevision: 3,
        nowIso: "not-a-time",
      }).isValid,
    ).toBe(false);
  });
});
