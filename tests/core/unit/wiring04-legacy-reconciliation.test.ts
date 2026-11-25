/**
 * WIRING-04-01 补口（2026-11-25）：旧状态迁移对账的反例。
 */
import { describe, expect, it } from "vitest";

import { reconcileLegacyAppliedWithoutIntent } from "../../../packages/core/src/orchestration/coordination-consumption-runner.js";

const evidence = (contentFingerprint: string | null) => ({ contentFingerprint });

describe("WIRING-04-01 旧 applied 无意图迁移", () => {
  it("① 无证据 ⇒ needs-reconciliation（不重放、不推断）", () => {
    const results = reconcileLegacyAppliedWithoutIntent({
      appliedMessages: [
        { messageIdentifier: "m-1", missionIdentifier: "mission-1", contentFingerprint: "fp-1" },
      ],
      trackedMessageIdentifiers: new Set(),
      authoritativeEvidence: new Map(),
    });
    expect(results).toEqual([
      {
        messageIdentifier: "m-1",
        outcome: "needs-reconciliation",
        reason: expect.stringContaining("不自动重放"),
      },
    ]);
  });

  it("② 有同消息应用证据且指纹一致 ⇒ 只补 completed", () => {
    const results = reconcileLegacyAppliedWithoutIntent({
      appliedMessages: [
        { messageIdentifier: "m-1", missionIdentifier: "mission-1", contentFingerprint: "fp-1" },
      ],
      trackedMessageIdentifiers: new Set(),
      authoritativeEvidence: new Map([["m-1", evidence("fp-1")]]),
    });
    expect(results[0]).toMatchObject({ outcome: "backfillable-completed" });
  });

  it("③ 指纹冲突 ⇒ conflict（不补、不重放）", () => {
    const results = reconcileLegacyAppliedWithoutIntent({
      appliedMessages: [
        { messageIdentifier: "m-1", missionIdentifier: "mission-1", contentFingerprint: "fp-1" },
      ],
      trackedMessageIdentifiers: new Set(),
      authoritativeEvidence: new Map([["m-1", evidence("fp-2")]]),
    });
    expect(results[0]).toMatchObject({ outcome: "conflict" });
  });

  it("④ 旧记录缺指纹但证据存在 ⇒ 仍可补 completed（不因缺指纹阻塞）", () => {
    const results = reconcileLegacyAppliedWithoutIntent({
      appliedMessages: [
        { messageIdentifier: "m-1", missionIdentifier: "mission-1", contentFingerprint: null },
      ],
      trackedMessageIdentifiers: new Set(),
      authoritativeEvidence: new Map([["m-1", evidence("fp-1")]]),
    });
    expect(results[0]).toMatchObject({ outcome: "backfillable-completed" });
  });

  it("⑤ 已有意图 ⇒ already-tracked（不重复补）", () => {
    const results = reconcileLegacyAppliedWithoutIntent({
      appliedMessages: [
        { messageIdentifier: "m-1", missionIdentifier: "mission-1", contentFingerprint: "fp-1" },
      ],
      trackedMessageIdentifiers: new Set(["m-1"]),
      authoritativeEvidence: new Map([["m-1", evidence("fp-1")]]),
    });
    expect(results[0]).toMatchObject({ outcome: "already-tracked" });
  });

  it("⑥ 任务恰好 done 但没有同消息证据 ⇒ 仍是 needs-reconciliation（不按状态推断）", () => {
    const results = reconcileLegacyAppliedWithoutIntent({
      appliedMessages: [
        { messageIdentifier: "m-9", missionIdentifier: "mission-1", contentFingerprint: "fp-9" },
      ],
      trackedMessageIdentifiers: new Set(),
      authoritativeEvidence: new Map(),
    });
    expect(results[0]).toMatchObject({ outcome: "needs-reconciliation" });
  });
});
