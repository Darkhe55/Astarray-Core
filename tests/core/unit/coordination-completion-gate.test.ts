/**
 * P1-2（2026-11-17）：协调完成入口的**权威完成门禁**。
 *
 * 反例全部来自真实风险：迟到反馈、跨项目/跨来源张冠李戴、缺收据却声称完成、
 * 已有审查结论被协调消息覆盖。
 */
import { describe, expect, it } from "vitest";

import { evaluateCoordinationCompletion } from "../../../packages/core/src/orchestration/coordination-completion-gate.js";

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "done" as const,
    sourceAgentInstanceIdentifier: "worker-1",
    messageMissionIdentifier: "mission-1",
    messageProjectIdentifier: "project-alpha",
    task: {
      id: "T-001",
      status: "running",
      assignedAgentId: "worker-1",
      taskType: "data",
    },
    missionProjectIdentifier: "project-alpha",
    completionReceiptIdentifier: null,
    reviewState: "none" as const,
    ...overrides,
  } as never;
}

describe("协调完成门禁", () => {
  it("① 缺完成收据 ⇒ 拒绝（success 文本不能判 done）", () => {
    const decision = evaluateCoordinationCompletion(buildInput());
    expect(decision.isAccepted).toBe(false);
    expect(decision.code).toBe("completion-receipt-required");
  });

  it("② 缺来源个体 ⇒ 拒绝（不能默认绑定当前执行）", () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({ sourceAgentInstanceIdentifier: null }),
    );
    expect(decision.code).toBe("source-unknown");
  });

  it("③ 来源不是受派个体 ⇒ 拒绝（迟到/冒名反馈不得结算）", () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({ sourceAgentInstanceIdentifier: "worker-9" }),
    );
    expect(decision.code).toBe("source-not-assignee");
  });

  it("④ 跨项目 ⇒ 拒绝", () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({ messageProjectIdentifier: "project-beta" }),
    );
    expect(decision.code).toBe("project-mismatch");
  });

  it("⑤ 任务已不在执行中 ⇒ 拒绝（旧执行反馈）", () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({
        task: { id: "T-001", status: "done", assignedAgentId: "worker-1", taskType: "data" },
      }),
    );
    expect(decision.code).toBe("task-not-running");
  });

  it("⑥ 已有审查结论 ⇒ 拒绝（协调入口不得覆盖返修/通过）", () => {
    expect(evaluateCoordinationCompletion(buildInput({ reviewState: "rework" })).code).toBe(
      "review-already-decided",
    );
    expect(evaluateCoordinationCompletion(buildInput({ reviewState: "accepted" })).code).toBe(
      "review-already-decided",
    );
  });

  it("⑦ 正在审查中 ⇒ 拒绝（不得绕过审查）", () => {
    expect(evaluateCoordinationCompletion(buildInput({ reviewState: "pending" })).code).toBe(
      "review-pending",
    );
  });

  it("⑧ 带完成收据且来源一致 ⇒ 接受（验收仍由独立审查决定）", () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({ completionReceiptIdentifier: "receipt-1" }),
    );
    expect(decision.isAccepted).toBe(true);
    expect(decision.code).toBe("accepted");
  });

  it("⑨ 失败反馈 ⇒ 接受（如实推进执行状态，不涉及验收）", () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({ outcome: "failed", completionReceiptIdentifier: null }),
    );
    expect(decision.isAccepted).toBe(true);
  });
});

describe("审查状态解析（读权威裁决）", () => {
  it("⑩ 已通过 ⇒ accepted；已拒绝 ⇒ rework（协调入口不得覆盖）", async () => {
    const { resolveReviewStateForCoordination } = await import(
      "../../../packages/core/src/orchestration/coordination-completion-gate.js"
    );
    expect(resolveReviewStateForCoordination({ verdict: "accepted", taskType: "data" })).toBe(
      "accepted",
    );
    expect(resolveReviewStateForCoordination({ verdict: "rejected", taskType: "data" })).toBe(
      "rework",
    );
  });

  it("⑪ 无裁决：审查型任务 => pending；普通任务 => none", async () => {
    const { resolveReviewStateForCoordination } = await import(
      "../../../packages/core/src/orchestration/coordination-completion-gate.js"
    );
    expect(resolveReviewStateForCoordination({ verdict: null, taskType: "review" })).toBe("pending");
    expect(resolveReviewStateForCoordination({ verdict: null, taskType: "data" })).toBe("none");
  });

  it("⑫ 已拒绝的任务，再来协调 success ⇒ 仍被拒（返修不得被覆盖）", async () => {
    const decision = evaluateCoordinationCompletion(
      buildInput({ reviewState: "rework", completionReceiptIdentifier: "receipt-1" }),
    );
    expect(decision.isAccepted).toBe(false);
    expect(decision.code).toBe("review-already-decided");
  });
});

describe("权威完成校验（两入口共用同一函数）", () => {
  it("⑬ 协调入口：无收据 ⇒ 拒绝；有收据 ⇒ 接受", async () => {
    const { evaluateAuthoritativeCompletion } = await import(
      "../../../packages/core/src/orchestration/authoritative-completion.js"
    );
    const base = {
      entryKind: "coordination-message" as const,
      outcome: "done" as const,
      sourceAgentInstanceIdentifier: "worker-1",
      messageMissionIdentifier: "mission-1",
      messageProjectIdentifier: "project-alpha",
      task: { id: "T-001", status: "running", assignedAgentId: "worker-1", taskType: "data" },
      missionProjectIdentifier: "project-alpha",
      requiresCompletionControlEvent: false,
      isCompletionReceiptRequired: true,
      reviewState: "none" as const,
    };
    expect(evaluateAuthoritativeCompletion({ ...base, completionReceipt: null }).isAccepted).toBe(
      false,
    );
    expect(
      evaluateAuthoritativeCompletion({
        ...base,
        completionReceipt: {
          taskIdentifier: "T-001",
          missionIdentifier: "mission-1",
          toolCallCount: 1,
          artifactPaths: ["out.md"],
          hasVerifiedCompletionControlEvent: true,
        } as never,
      }).isAccepted,
    ).toBe(true);
  });

  it("⑭ Worker 入口：跳过消息侧自证，但仍校验收据", async () => {
    const { evaluateAuthoritativeCompletion } = await import(
      "../../../packages/core/src/orchestration/authoritative-completion.js"
    );
    const decision = evaluateAuthoritativeCompletion({
      entryKind: "worker",
      outcome: "done",
      sourceAgentInstanceIdentifier: "worker-1",
      messageMissionIdentifier: null,
      messageProjectIdentifier: null,
      task: { id: "T-001", status: "running", assignedAgentId: "worker-1", taskType: "data" },
      missionProjectIdentifier: null,
      completionReceipt: null,
      requiresCompletionControlEvent: false,
      isCompletionReceiptRequired: true,
      reviewState: "none",
    });
    expect(decision.isAccepted).toBe(false);
    expect(decision.code).toBe("completion-receipt-insufficient");
  });
});

describe("畸形收据不得抛异常（健壮性）", () => {
  it("⑮ 缺 missionIdentifier 的收据 ⇒ 返回「收据不足」，不是 TypeError", async () => {
    const { evaluateCompletionReceipt } = await import(
      "../../../packages/core/src/orchestration/completion-receipt.js"
    );
    const evaluation = evaluateCompletionReceipt({
      receipt: { taskIdentifier: "T-001", toolCallCount: 1, artifactPaths: [] } as never,
      requiresCompletionControlEvent: false,
    });
    expect(evaluation.isSufficient).toBe(false);
    expect(evaluation.reasons.join("；")).toContain("mission");
  });
});
