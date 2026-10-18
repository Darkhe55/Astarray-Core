/**
 * LESSON-01-01 的反例（2026-10-18 R13）：沟通经验记录契约。
 *
 * 卡内验收：双方配置取自运行时；unknown 明确；事实/假设分离；
 * 主 Agent 无新增写工具；非法来源/跨个体写入拒绝；默认任务专属、未验证不自动注入。
 */
import { describe, expect, it } from "vitest";

import {
  LESSON_DEFAULT_SCOPE_KIND,
  MAIN_AGENT_LESSON_WRITE_CAPABILITY,
  evaluateLessonWrite,
  isLessonApplicableToTask,
  isLessonAutoInjectible,
  validateLessonRecord,
  type LessonModelSnapshot,
  type LessonRecordInput,
} from "../../../packages/core/src/orchestration/lesson-record-contract.js";

function snapshot(overrides: Partial<LessonModelSnapshot> = {}): LessonModelSnapshot {
  return {
    providerIdentifier: "provider-x",
    modelIdentifier: "model-1",
    modelVersionIdentifier: "2026-09",
    effectiveConfiguration: { reasoningEffort: "high" },
    ...overrides,
  };
}

function record(overrides: Partial<LessonRecordInput> = {}): LessonRecordInput {
  return {
    ownerAgentInstanceId: "agent-owner",
    recordIdentifier: "lesson-1",
    revision: 1,
    sourceTaskIdentifier: "task-1",
    sourceEvidenceReferences: ["message:42", "tool:readFile#3"],
    publisherAgentInstanceId: "agent-publisher",
    recipientAgentInstanceId: "agent-recipient",
    publisherRole: "secondary",
    recipientRole: "tertiary",
    communicationDirection: "publisher-to-recipient",
    communicationStage: "dispatch",
    publisherModelSnapshot: snapshot(),
    recipientModelSnapshot: snapshot({ modelIdentifier: "model-2" }),
    snapshotSource: "runtime",
    taskContextDescription: "code-review 任务：需要核对异步失败分支",
    observableFacts: ["修改了错误命名空间中的符号"],
    causeHypotheses: ["定位信息不足且未澄清"],
    nextActionAdvice: ["候选目标不唯一时先询问"],
    scopeKind: "task",
    validityStatus: "unverified-observation",
    promotionStatus: "not-eligible",
    createdAtIso: "2026-10-18T00:00:00.000Z",
    verifiedAtIso: null,
    policyVersion: "policy-v1",
    ...overrides,
  };
}

describe("LESSON-01-01：沟通经验记录契约", () => {
  it("① 默认范围是任务专属，主 Agent 无写入能力（常量冻结）", () => {
    expect(LESSON_DEFAULT_SCOPE_KIND).toBe("task");
    expect(MAIN_AGENT_LESSON_WRITE_CAPABILITY).toBe("none");
  });

  it("② 完整记录 ⇒ accepted，且指纹确定（同内容同指纹、事实变则变）", () => {
    const accepted = validateLessonRecord(record());
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("应接受");
    expect(accepted.fingerprint).toHaveLength(64);
    const same = validateLessonRecord(record());
    if (same.kind !== "accepted") throw new Error("应接受");
    expect(same.fingerprint).toBe(accepted.fingerprint);
    const changedFact = validateLessonRecord(record({ observableFacts: ["另一条事实"] }));
    if (changedFact.kind !== "accepted") throw new Error("应接受");
    expect(changedFact.fingerprint).not.toBe(accepted.fingerprint);
  });

  it("③ 配置快照必须取自运行时（写总结时重建 ⇒ 拒绝）", () => {
    const rejected = validateLessonRecord(record({ snapshotSource: "reconstructed" }));
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("snapshot-not-runtime");
  });

  it("④ unknown 必须显式（空版本 ⇒ 拒绝；写 unknown ⇒ 接受但只能参考匹配）", () => {
    const emptyVersion = validateLessonRecord(
      record({ publisherModelSnapshot: snapshot({ modelVersionIdentifier: "" }) }),
    );
    expect(emptyVersion.kind).toBe("rejected");
    if (emptyVersion.kind !== "rejected") throw new Error("应拒绝");
    expect(emptyVersion.reasonCode).toBe("unclear-unknown");

    const unknownVersion = record({
      publisherModelSnapshot: snapshot({ modelVersionIdentifier: "unknown" }),
    });
    expect(validateLessonRecord(unknownVersion).kind).toBe("accepted");
    const applicability = isLessonApplicableToTask({
      record: unknownVersion,
      current: {
        communicationDirection: "publisher-to-recipient",
        publisherRole: "secondary",
        recipientRole: "tertiary",
        publisherModelSnapshot: snapshot(),
        recipientModelSnapshot: snapshot({ modelIdentifier: "model-2" }),
        taskType: "code-review",
        triggerCondition: "ambiguous-symbol",
      },
    });
    expect(applicability.matchQuality).toBe("reference-only");
    expect(applicability.isApplicable).toBe(true);
    expect(applicability.differences).toContain("model-version-unknown");
  });

  it("⑤ 事实/假设混写 ⇒ 拒绝（不能把猜测写成确定事实）", () => {
    const rejected = validateLessonRecord(
      record({
        observableFacts: ["修改了错误命名空间中的符号"],
        causeHypotheses: ["修改了错误命名空间中的符号"],
      }),
    );
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("facts-hypotheses-mixed");
  });

  it("⑥ 事实没有证据引用 ⇒ 拒绝", () => {
    const rejected = validateLessonRecord(record({ sourceEvidenceReferences: [] }));
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("facts-without-evidence");
  });

  it("⑦ 配置快照含凭据/令牌/私密端点 ⇒ 拒绝", () => {
    for (const sensitiveName of ["apiKey", "authToken", "clientSecret", "privateKey"]) {
      const rejected = validateLessonRecord(
        record({
          publisherModelSnapshot: snapshot({
            effectiveConfiguration: { reasoningEffort: "high", [sensitiveName]: "zzz" },
          }),
        }),
      );
      expect(rejected.kind).toBe("rejected");
      if (rejected.kind !== "rejected") throw new Error("应拒绝");
      expect(rejected.reasonCode).toBe("sensitive-config-included");
    }
  });

  it("⑧ 未验证观察不自动注入；已核验才注入；被推广拒绝也不注入", () => {
    expect(isLessonAutoInjectible(record())).toBe(false);
    expect(
      isLessonAutoInjectible(record({ validityStatus: "verified", promotionStatus: "approved-for-reuse" })),
    ).toBe(true);
    expect(
      isLessonAutoInjectible(record({ validityStatus: "disproven", promotionStatus: "approved-for-reuse" })),
    ).toBe(false);
    expect(
      isLessonAutoInjectible(record({ validityStatus: "verified", promotionStatus: "rejected" })),
    ).toBe(false);
  });

  it("⑨ 写入：主 Agent 模型禁止；跨个体禁止；本地控制面可代理；未核验不得自批推广", () => {
    expect(
      evaluateLessonWrite({
        writerAgentInstanceId: "agent-x",
        ownerAgentInstanceId: "agent-x",
        isLocalControlPlane: false,
        isMainAgentModel: true,
        validityStatus: "verified",
        promotionStatus: "approved-for-reuse",
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "main-agent-write-forbidden" });

    expect(
      evaluateLessonWrite({
        writerAgentInstanceId: "agent-other",
        ownerAgentInstanceId: "agent-owner",
        isLocalControlPlane: false,
        isMainAgentModel: false,
        validityStatus: "verified",
        promotionStatus: "not-eligible",
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "cross-individual-write" });

    expect(
      evaluateLessonWrite({
        writerAgentInstanceId: null,
        ownerAgentInstanceId: "agent-owner",
        isLocalControlPlane: true,
        isMainAgentModel: false,
        validityStatus: "verified",
        promotionStatus: "not-eligible",
      }).kind,
    ).toBe("allowed");

    expect(
      evaluateLessonWrite({
        writerAgentInstanceId: "agent-owner",
        ownerAgentInstanceId: "agent-owner",
        isLocalControlPlane: false,
        isMainAgentModel: false,
        validityStatus: "unverified-observation",
        promotionStatus: "approved-for-reuse",
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "unverified-promotion" });
  });

  it("⑩ 适用匹配：严格匹配才注入；任务类型不同不适用；模型不同不适用", () => {
    const current = {
      communicationDirection: "publisher-to-recipient" as const,
      publisherRole: "secondary",
      recipientRole: "tertiary",
      publisherModelSnapshot: snapshot(),
      recipientModelSnapshot: snapshot({ modelIdentifier: "model-2" }),
      taskType: "code-review",
      triggerCondition: "ambiguous-symbol",
    };
    const exact = isLessonApplicableToTask({ record: record(), current });
    expect(exact.isApplicable).toBe(true);
    expect(exact.matchQuality).toBe("exact");

    const differentTask = isLessonApplicableToTask({
      record: record({ taskContextDescription: "文案审阅任务" }),
      current,
    });
    expect(differentTask.isApplicable).toBe(false);
    expect(differentTask.differences).toContain("task-type");

    const differentModel = isLessonApplicableToTask({
      record: record({ recipientModelSnapshot: snapshot({ modelIdentifier: "model-9" }) }),
      current,
    });
    expect(differentModel.isApplicable).toBe(false);
    expect(differentModel.differences).toContain("recipient-model");
  });

  it("⑪ 模型无关规范：未经用户确认不得跨模型自动使用", () => {
    const norm = record({ scopeKind: "model-independent-norm" });
    const current = {
      communicationDirection: "publisher-to-recipient" as const,
      publisherRole: "secondary",
      recipientRole: "tertiary",
      publisherModelSnapshot: snapshot(),
      recipientModelSnapshot: snapshot({ modelIdentifier: "model-2" }),
      taskType: "code-review",
      triggerCondition: "ambiguous-symbol",
    };
    expect(isLessonApplicableToTask({ record: norm, current }).isApplicable).toBe(false);
    expect(
      isLessonApplicableToTask({
        record: norm,
        current,
        isModelIndependentNormConfirmedByUser: true,
      }).isApplicable,
    ).toBe(true);
  });
});
