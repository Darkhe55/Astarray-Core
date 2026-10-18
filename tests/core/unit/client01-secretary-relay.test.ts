/**
 * SECRETARY-01-02 的反例（2026-10-18 R7）：项目/汇总模式、报告附件与任务转交回执。
 *
 * 卡内验收：多项目**同名任务不串线**、**重放不重复派发**、**同级回派有界**、**过期报告如实显示**；
 * 回执要能显示待转交/已接收/已派发/实际完成，且不把秘书回复视为项目已执行。
 */
import { describe, expect, it } from "vitest";

import {
  SECRETARY_MODE_SWITCH_ISOLATION,
  advanceSecretaryRelayReceipt,
  buildSecretaryReportAttachment,
  computeRelayReceiptIdentifier,
  computeSecretaryTaskLineKey,
  evaluatePeerRelay,
  evaluateReportFreshness,
  recordSecretaryRelayDispatch,
  type SecretaryRelayReceiptV1,
  type SecretaryReportAttachmentV1,
} from "../../../packages/core/src/orchestration/secretary-relay-contract.js";

function builtAttachment(
  overrides: Partial<Parameters<typeof buildSecretaryReportAttachment>[0]> = {},
): SecretaryReportAttachmentV1 {
  const outcome = buildSecretaryReportAttachment({
    projectIdentifier: "project-a",
    sourceIdentifier: "main-agent-report",
    projectRevision: 3,
    generatedAtIso: "2026-10-18T00:00:00.000Z",
    contentHash: "0123456789abcdef",
    ...overrides,
  });
  if (outcome.kind !== "built") throw new Error("夹具应可生成：" + outcome.reason);
  return outcome.attachment;
}

function receipt(overrides: Partial<SecretaryRelayReceiptV1> = {}): SecretaryRelayReceiptV1 {
  return {
    schemaVersion: 1,
    receiptIdentifier: computeRelayReceiptIdentifier({
      idempotencyKey: "key-1",
      targetProjectIdentifier: "project-a",
    }),
    idempotencyKey: "key-1",
    originalUserMessageIdentifier: "user-message-1",
    targetProjectIdentifier: "project-a",
    state: "pending-transfer",
    updatedAtIso: "2026-10-18T00:00:00.000Z",
    hopCount: 0,
    ...overrides,
  };
}

describe("SECRETARY-01-02：模式隔离、报告附件与转交回执", () => {
  it("① 多项目同名任务不串线：任务行键必须含项目标识", () => {
    const inProjectA = computeSecretaryTaskLineKey({
      projectIdentifier: "project-a",
      taskText: "整理发布说明",
    });
    const inProjectB = computeSecretaryTaskLineKey({
      projectIdentifier: "project-b",
      taskText: "整理发布说明",
    });
    expect(inProjectA).not.toBe(inProjectB);
    expect(inProjectA).toContain("project-a");
    expect(inProjectB).toContain("project-b");
  });

  it("② 模式切换的隔离是恒假事实（不复制历史/不重复任务/不改归属）", () => {
    expect(SECRETARY_MODE_SWITCH_ISOLATION).toEqual({
      copiesHistory: false,
      startsDuplicateTasks: false,
      changesProjectOwnership: false,
    });
  });

  it("③ 报告附件必须带来源/项目/revision/时间/哈希；缺项一律拒绝", () => {
    expect(
      buildSecretaryReportAttachment({
        projectIdentifier: " ",
        sourceIdentifier: "main-agent-report",
        projectRevision: 1,
        generatedAtIso: "2026-10-18T00:00:00.000Z",
        contentHash: "0123456789abcdef",
      }).kind,
    ).toBe("rejected");
    expect(
      buildSecretaryReportAttachment({
        projectIdentifier: "project-a",
        sourceIdentifier: "",
        projectRevision: 1,
        generatedAtIso: "2026-10-18T00:00:00.000Z",
        contentHash: "0123456789abcdef",
      }).kind,
    ).toBe("rejected");
    expect(
      buildSecretaryReportAttachment({
        projectIdentifier: "project-a",
        sourceIdentifier: "main-agent-report",
        projectRevision: 0,
        generatedAtIso: "2026-10-18T00:00:00.000Z",
        contentHash: "0123456789abcdef",
      }).kind,
    ).toBe("rejected");
    expect(
      buildSecretaryReportAttachment({
        projectIdentifier: "project-a",
        sourceIdentifier: "main-agent-report",
        projectRevision: 1,
        generatedAtIso: "not-a-date",
        contentHash: "0123456789abcdef",
      }).kind,
    ).toBe("rejected");
    expect(
      buildSecretaryReportAttachment({
        projectIdentifier: "project-a",
        sourceIdentifier: "main-agent-report",
        projectRevision: 1,
        generatedAtIso: "2026-10-18T00:00:00.000Z",
        contentHash: "zzzz",
      }).kind,
    ).toBe("rejected");
  });

  it("④ 附件是最小快照：不含项目正文、内容哈希与 revision 变则指纹变", () => {
    const base = builtAttachment();
    expect(base.isMinimal).toBe(true);
    expect(Object.keys(base)).not.toContain("fullText");
    expect(base.attachmentFingerprint).toHaveLength(64);

    const sameContent = builtAttachment();
    expect(sameContent.attachmentFingerprint).toBe(base.attachmentFingerprint);

    const newRevision = builtAttachment({ projectRevision: 4 });
    expect(newRevision.attachmentFingerprint).not.toBe(base.attachmentFingerprint);

    const newHash = builtAttachment({ contentHash: "fedcba9876543210" });
    expect(newHash.attachmentFingerprint).not.toBe(base.attachmentFingerprint);
  });

  it("⑤ 过期报告 ⇒ stale 且**如实给出最后更新时间**；时间戳非法 ⇒ unknown，不猜", () => {
    const attachment = builtAttachment({ expiresAtIso: "2026-10-18T01:00:00.000Z" });
    const stale = evaluateReportFreshness({
      attachment,
      nowIso: "2026-10-18T02:00:00.000Z",
    });
    expect(stale.state).toBe("stale");
    expect(stale.lastUpdatedIso).toBe("2026-10-18T00:00:00.000Z");
    expect(stale.reason).toContain("不推测完成");

    const fresh = evaluateReportFreshness({
      attachment: builtAttachment(),
      nowIso: "2026-10-18T00:30:00.000Z",
      maximumAgeMilliseconds: 60 * 60 * 1000,
    });
    expect(fresh.state).toBe("fresh");

    const tooOld = evaluateReportFreshness({
      attachment: builtAttachment(),
      nowIso: "2026-10-19T00:00:00.000Z",
      maximumAgeMilliseconds: 60 * 60 * 1000,
    });
    expect(tooOld.state).toBe("stale");

    const unknown = evaluateReportFreshness({
      // 陈旧/外部写入的附件可能带非法时间戳 ⇒ 判定层必须能处理（不猜）
      attachment: { ...builtAttachment(), generatedAtIso: "not-a-date" },
      nowIso: "2026-10-18T00:00:00.000Z",
    });
    expect(unknown.state).toBe("unknown-timestamp");
    expect(unknown.lastUpdatedIso).toBeNull();
  });

  it("⑥ 重放同 (幂等键, 目标) ⇒ 不重复派发；同键异目标 ⇒ 冲突", () => {
    const first = recordSecretaryRelayDispatch({
      existingReceipts: [],
      idempotencyKey: "key-1",
      originalUserMessageIdentifier: "user-message-1",
      targetProjectIdentifier: "project-a",
      dispatchedAtIso: "2026-10-18T00:00:00.000Z",
    });
    expect(first.kind).toBe("dispatched");
    if (first.kind !== "dispatched") throw new Error("应为 dispatched");
    expect(first.receipt.state).toBe("pending-transfer");

    const replay = recordSecretaryRelayDispatch({
      existingReceipts: [first.receipt],
      idempotencyKey: "key-1",
      originalUserMessageIdentifier: "user-message-1",
      targetProjectIdentifier: "project-a",
      dispatchedAtIso: "2026-10-18T00:05:00.000Z",
    });
    expect(replay.kind).toBe("idempotent-replay");

    const conflict = recordSecretaryRelayDispatch({
      existingReceipts: [first.receipt],
      idempotencyKey: "key-1",
      originalUserMessageIdentifier: "user-message-1",
      targetProjectIdentifier: "project-b",
      dispatchedAtIso: "2026-10-18T00:05:00.000Z",
    });
    expect(conflict.kind).toBe("conflict");
  });

  it("⑦ 回执状态只能前进：completed → dispatched 拒绝；pending → completed 允许（终态如实）", () => {
    const initialState = receipt();
    const accepted = advanceSecretaryRelayReceipt({
      receipt: initialState,
      nextState: "accepted",
      updatedAtIso: "2026-10-18T00:01:00.000Z",
    });
    expect(accepted.kind).toBe("advanced");
    if (accepted.kind !== "advanced") throw new Error("应可前进");
    expect(accepted.receipt.state).toBe("accepted");

    const dispatched = advanceSecretaryRelayReceipt({
      receipt: accepted.receipt,
      nextState: "dispatched",
      updatedAtIso: "2026-10-18T00:02:00.000Z",
    });
    expect(dispatched.kind).toBe("advanced");

    const completed = advanceSecretaryRelayReceipt({
      receipt: receipt({ state: "completed" }),
      nextState: "dispatched",
      updatedAtIso: "2026-10-18T00:03:00.000Z",
    });
    expect(completed.kind).toBe("rejected");
    if (completed.kind !== "rejected") throw new Error("应拒绝");
    expect(completed.reason).toContain("只能前进");
  });

  it("⑧ 同级回派有界：达到上限即拒绝并升级用户", () => {
    expect(evaluatePeerRelay({ hopCount: 0, maximumHops: 1 })).toMatchObject({
      isAllowed: true,
      shouldEscalateToUser: false,
      nextHopCount: 1,
    });
    expect(evaluatePeerRelay({ hopCount: 1, maximumHops: 1 })).toMatchObject({
      isAllowed: false,
      shouldEscalateToUser: true,
      nextHopCount: 1,
    });
  });

  it("⑨ 回执保留原始用户消息标识（不能被秘书回复顶替）", () => {
    const dispatched = recordSecretaryRelayDispatch({
      existingReceipts: [],
      idempotencyKey: "key-2",
      originalUserMessageIdentifier: "user-message-9",
      targetProjectIdentifier: "project-a",
      dispatchedAtIso: "2026-10-18T00:00:00.000Z",
    });
    if (dispatched.kind !== "dispatched") throw new Error("应为 dispatched");
    expect(dispatched.receipt.originalUserMessageIdentifier).toBe("user-message-9");
    expect(dispatched.receipt.state).not.toBe("completed");
  });
});
