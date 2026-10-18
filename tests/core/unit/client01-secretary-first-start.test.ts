/**
 * SECRETARY-01-03 的反例（2026-10-18 R8）：次日首次启动判定、同日领取与历史收拢。
 *
 * 卡内验收：**跨午夜/短重启/多窗口/崩溃/DST/改时区无重复整理**；关闭显示不删历史，旧未决项可见。
 */
import { describe, expect, it } from "vitest";

import {
  applyDailyProcessingClaim,
  buildCollapsedSecretaryView,
  computeLocalCalendarDate,
  evaluateSecretaryFirstStartOfDay,
  type SecretaryViewItem,
} from "../../../packages/core/src/orchestration/secretary-first-start.js";

const baseInput = {
  nowIso: "2026-10-18T09:00:00.000Z",
  timeZone: "Asia/Shanghai",
  minimumClientClosedDurationMinutes: 360,
  lastClosedAtIso: "2026-10-17T10:00:00.000Z",
  lastHeartbeatAtIso: "2026-10-17T10:00:00.000Z",
  lastProcessedLocalDates: [] as ReadonlyArray<string>,
};

function item(
  messageIdentifier: string,
  localDate: string,
  category: SecretaryViewItem["category"],
): SecretaryViewItem {
  return {
    messageIdentifier,
    localDate,
    category,
    projectIdentifier: "project-a",
    recordedAtIso: `${localDate}T01:00:00.000Z`,
  };
}

describe("SECRETARY-01-03：次日首次启动、同日领取与历史收拢", () => {
  it("① 正常跨日且离线超阈值 ⇒ trigger（不阻塞启动、仍需 CURATE 授权）", () => {
    const decision = evaluateSecretaryFirstStartOfDay(baseInput);
    expect(decision.kind).toBe("trigger");
    if (decision.kind !== "trigger") throw new Error("应触发");
    expect(decision.targetLocalDate).toBe("2026-10-18");
    expect(decision.doesBlockStartup).toBe(false);
    expect(decision.requiresCurationAuthorization).toBe(true);
    expect(decision.isEstimatedCloseTime).toBe(false);
    expect(decision.offlineDurationMinutes).toBeGreaterThan(360);
  });

  it("② 单纯跨午夜但离线不够 ⇒ 不触发（短重启）", () => {
    const decision = evaluateSecretaryFirstStartOfDay({
      ...baseInput,
      // 上海时间 10-17 23:50 关闭、10-18 00:30 启动：**确实跨了本地午夜**，但只离线 40 分钟
      lastClosedAtIso: "2026-10-17T15:50:00.000Z",
      nowIso: "2026-10-17T16:30:00.000Z",
    });
    expect(decision.kind).toBe("no-trigger");
    if (decision.kind !== "no-trigger") throw new Error("应不触发");
    expect(decision.reasonCode).toBe("closed-too-short");
  });

  it("③ 同一本地日历日（长开客户端）⇒ 不假装首次启动", () => {
    const decision = evaluateSecretaryFirstStartOfDay({
      ...baseInput,
      lastClosedAtIso: "2026-10-18T00:30:00.000Z",
      nowIso: "2026-10-18T09:00:00.000Z",
    });
    expect(decision.kind).toBe("no-trigger");
    if (decision.kind !== "no-trigger") throw new Error("应不触发");
    expect(decision.reasonCode).toBe("same-local-day");
  });

  it("④ 该本地日已处理 ⇒ 不重复整理（ID 幂等）", () => {
    const decision = evaluateSecretaryFirstStartOfDay({
      ...baseInput,
      lastProcessedLocalDates: ["2026-10-18"],
    });
    expect(decision.kind).toBe("no-trigger");
    if (decision.kind !== "no-trigger") throw new Error("应不触发");
    expect(decision.reasonCode).toBe("already-processed");
  });

  it("⑤ 崩溃（无关闭时刻）⇒ 用心跳估计并标记估计值；心跳也缺 ⇒ 保守不触发", () => {
    const estimated = evaluateSecretaryFirstStartOfDay({
      ...baseInput,
      lastClosedAtIso: null,
      lastHeartbeatAtIso: "2026-10-17T10:00:00.000Z",
    });
    expect(estimated.kind).toBe("trigger");
    if (estimated.kind !== "trigger") throw new Error("应触发");
    expect(estimated.isEstimatedCloseTime).toBe(true);

    const unknown = evaluateSecretaryFirstStartOfDay({
      ...baseInput,
      lastClosedAtIso: null,
      lastHeartbeatAtIso: null,
    });
    expect(unknown.kind).toBe("no-trigger");
    if (unknown.kind !== "no-trigger") throw new Error("应不触发");
    expect(unknown.reasonCode).toBe("no-baseline");
  });

  it("⑥ 时钟回拨 ⇒ 不触发", () => {
    const decision = evaluateSecretaryFirstStartOfDay({
      ...baseInput,
      lastClosedAtIso: "2026-10-18T12:00:00.000Z",
      nowIso: "2026-10-18T09:00:00.000Z",
    });
    expect(decision.kind).toBe("no-trigger");
    if (decision.kind !== "no-trigger") throw new Error("应不触发");
    expect(decision.reasonCode).toBe("clock-rollback");
  });

  it("⑦ DST/改时区：同一瞬间在不同时区得到不同本地日（策略明确、不猜）", () => {
    // 2026-03-08 是美国 DST 生效日；06:30Z = 01:30 EST（仍是 3-8）
    expect(
      computeLocalCalendarDate({ instantIso: "2026-03-08T06:30:00.000Z", timeZone: "America/New_York" }),
    ).toBe("2026-03-08");
    // 同一瞬间在东京已是 3-8 15:30，在上海同样是 3-8 14:30
    expect(
      computeLocalCalendarDate({ instantIso: "2026-03-08T06:30:00.000Z", timeZone: "Asia/Tokyo" }),
    ).toBe("2026-03-08");
    // 跨日边界：23:30Z = 上海 07:30（次日 3-9）而纽约仍是 3-8 19:30
    expect(
      computeLocalCalendarDate({ instantIso: "2026-03-08T23:30:00.000Z", timeZone: "Asia/Shanghai" }),
    ).toBe("2026-03-09");
    expect(
      computeLocalCalendarDate({ instantIso: "2026-03-08T23:30:00.000Z", timeZone: "America/New_York" }),
    ).toBe("2026-03-08");
    // 非法时区 ⇒ null（不猜）
    expect(
      computeLocalCalendarDate({ instantIso: "2026-03-08T23:30:00.000Z", timeZone: "Not/AZone" }),
    ).toBeNull();
  });

  it("⑧ 同日领取：多窗口只有一个能领；同窗口重放是幂等重放", () => {
    const first = applyDailyProcessingClaim({
      existingClaims: [],
      localDate: "2026-10-18",
      claimantWindowIdentifier: "window-1",
      claimedAtIso: "2026-10-18T09:00:00.000Z",
    });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("应领取成功");

    const otherWindow = applyDailyProcessingClaim({
      existingClaims: [first.claim],
      localDate: "2026-10-18",
      claimantWindowIdentifier: "window-2",
      claimedAtIso: "2026-10-18T09:00:01.000Z",
    });
    expect(otherWindow.kind).toBe("already-claimed");
    if (otherWindow.kind !== "already-claimed") throw new Error("应已被领取");
    expect(otherWindow.reason).toContain("另一个窗口");

    const replay = applyDailyProcessingClaim({
      existingClaims: [first.claim],
      localDate: "2026-10-18",
      claimantWindowIdentifier: "window-1",
      claimedAtIso: "2026-10-18T09:00:02.000Z",
    });
    expect(replay.kind).toBe("already-claimed");
    if (replay.kind !== "already-claimed") throw new Error("应幂等重放");
    expect(replay.reason).toContain("幂等");
  });

  it("⑨ 收拢视图：旧条目收拢但**不删除**，旧待决策/未完成仍可见，快捷入口四项", () => {
    const items = [
      item("today-1", "2026-10-18", "completed"),
      item("today-2", "2026-10-18", "pending-acceptance"),
      item("old-1", "2026-10-17", "completed"),
      item("old-2", "2026-10-17", "pending-human-attestation"),
      item("old-3", "2026-10-17", "needs-decision"),
      item("old-4", "2026-10-16", "unfinished"),
    ];
    const collapsed = buildCollapsedSecretaryView({
      items,
      todayLocalDate: "2026-10-18",
      showAllHistory: false,
    });
    expect(collapsed.areOlderDeleted).toBe(false);
    expect(collapsed.visibleItems.map((visible) => visible.messageIdentifier)).toEqual([
      "today-1",
      "today-2",
      "old-3",
      "old-4",
    ]);
    expect(collapsed.collapsedOlderCount).toBe(2);
    expect(collapsed.oldPendingItemsVisibleCount).toBe(2);
    expect(collapsed.quickEntries).toEqual([
      "today-schedule",
      "completed",
      "unfinished",
      "needs-my-decision",
    ]);
  });

  it("⑩ 显示全部历史：不收拢、仍不删除、旧未决仍计入可见", () => {
    const items = [
      item("old-1", "2026-10-17", "completed"),
      item("old-2", "2026-10-17", "needs-decision"),
    ];
    const all = buildCollapsedSecretaryView({
      items,
      todayLocalDate: "2026-10-18",
      showAllHistory: true,
    });
    expect(all.visibleItems).toHaveLength(2);
    expect(all.collapsedOlderCount).toBe(0);
    expect(all.areOlderDeleted).toBe(false);
    expect(all.oldPendingItemsVisibleCount).toBe(1);
  });

  it("⑪ 阈值/时区非法 ⇒ 不触发（不做猜测式整理）", () => {
    expect(
      evaluateSecretaryFirstStartOfDay({ ...baseInput, minimumClientClosedDurationMinutes: -1 }).kind,
    ).toBe("no-trigger");
    expect(
      evaluateSecretaryFirstStartOfDay({ ...baseInput, timeZone: "Not/AZone" }).kind,
    ).toBe("no-trigger");
  });
});
