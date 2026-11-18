/**
 * 2026-11-18 用户裁决 B：**没有任务链就不要写占位版本**。
 *
 * 独立工作流（侦察 → 摘要）没有任务链 ⇒ 摘要省略 `boundTaskRevision`，
 * 下游读到"缺失"即"版本未知"，而不是被一个假的 1 骗过去。
 */
import { describe, expect, it } from "vitest";

import { secondaryUserFacingSummarySchema } from "../../../packages/core/src/orchestration/agent-routing-schemas.js";

const baseSummary = {
  schemaVersion: 1,
  summaryId: "summary-1",
  secondaryAgentInstanceId: "secondary-1",
  boundTaskIdentifier: "mission-1",
  goal: "整理项目上下文",
  currentProgress: "侦察摘要已生成",
  keyResults: [{ resultSummary: "已生成摘要", evidenceReference: "sha256:abc" }],
  risksAndFailures: ["无"],
  pendingUserDecisions: ["无"],
  createdAtIso: "2026-11-18T00:00:00.000Z",
  /** 摘要文档自身的 revision（与绑定任务版本是两回事）。 */
  revision: 1,
};

describe("摘要版本的诚实性", () => {
  it("① 没有任务链 ⇒ 省略版本仍然合法（不得被迫写占位 1）", () => {
    const parsed = secondaryUserFacingSummarySchema.safeParse(baseSummary);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.boundTaskRevision).toBeUndefined();
  }, 30_000);

  it("② 有任务链 ⇒ 写入真实 version，并可被读到", () => {
    const parsed = secondaryUserFacingSummarySchema.safeParse({
      ...baseSummary,
      boundTaskRevision: 3,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.boundTaskRevision).toBe(3);
  }, 30_000);

  it("③ 非法版本（0 / 1.5）仍被拒绝（不能借「可选」塞垃圾）", () => {
    expect(
      secondaryUserFacingSummarySchema.safeParse({ ...baseSummary, boundTaskRevision: 0 }).success,
    ).toBe(false);
    expect(
      secondaryUserFacingSummarySchema.safeParse({ ...baseSummary, boundTaskRevision: 1.5 }).success,
    ).toBe(false);
  }, 30_000);
});
