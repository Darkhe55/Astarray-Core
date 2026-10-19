/**
 * 进程样本保留策略的反例（2026-10-19 R53）。
 *
 * 决策：≤10MB 预算 + 24h 保留；**不静默删除历史**（裁剪数量与原因必须如实报告）。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROCESS_SAMPLE_BUDGET_BYTES,
  DEFAULT_PROCESS_SAMPLE_RETENTION_HOURS,
  planProcessSampleRetention,
} from "../../../packages/core/src/orchestration/process-sample-retention.js";

const NOW_ISO = "2026-10-19T12:00:00.000Z";

function hoursAgoIso(hours: number): string {
  return new Date(Date.parse(NOW_ISO) - hours * 3_600_000).toISOString();
}

function sample(hoursAgo: number, bytes: number) {
  return { recordedAtIso: hoursAgoIso(hoursAgo), serializedBytes: bytes };
}

describe("进程样本保留策略（10MB / 24h）", () => {
  it("① 默认预算与保留期与 OBS 契约一致", () => {
    expect(DEFAULT_PROCESS_SAMPLE_BUDGET_BYTES).toBe(10 * 1024 * 1024);
    expect(DEFAULT_PROCESS_SAMPLE_RETENTION_HOURS).toBe(24);
  });

  it("② 全部在保留期内且未超预算 ⇒ 无需裁剪（显式 no-action）", () => {
    const plan = planProcessSampleRetention({
      samples: [sample(1, 100), sample(2, 100)],
      nowIso: NOW_ISO,
    });
    expect(plan.kind).toBe("no-action");
    expect(plan.retainedSampleCount).toBe(2);
    expect(plan.droppedByRetentionCount).toBe(0);
    expect(plan.droppedByBudgetCount).toBe(0);
  });

  it("③ 超过 24h 的样本过期淘汰，并**如实报告**条数与最旧时间", () => {
    const plan = planProcessSampleRetention({
      samples: [sample(30, 100), sample(25, 100), sample(1, 100)],
      nowIso: NOW_ISO,
    });
    expect(plan.kind).toBe("trim-required");
    expect(plan.droppedByRetentionCount).toBe(2);
    expect(plan.retainedSampleCount).toBe(1);
    expect(plan.oldestDroppedAtIso).toBe(hoursAgoIso(30));
    expect(plan.reason).toContain("过期 2 条");
  });

  it("④ 超预算 ⇒ **优先保留最新**样本，淘汰最旧的", () => {
    const plan = planProcessSampleRetention({
      samples: [sample(3, 600), sample(2, 600), sample(1, 600)],
      nowIso: NOW_ISO,
      budgetBytes: 1200,
    });
    expect(plan.droppedByBudgetCount).toBe(1);
    expect(plan.retainedSampleCount).toBe(2);
    expect(plan.retainedBytes).toBe(1200);
    // 保留的是**最新的两条**（1h/2h）；3 小时前那条被裁 —— 只断言计数无法区分方向（变异曾因此存活）
    expect(plan.retainedNewestAtIso).toBe(hoursAgoIso(1));
    expect(plan.retainedOldestAtIso).toBe(hoursAgoIso(2));
  });

  it("⑤ 过期与超预算可同时发生，两类原因分别计数", () => {
    const plan = planProcessSampleRetention({
      samples: [sample(48, 500), sample(2, 800), sample(1, 800)],
      nowIso: NOW_ISO,
      budgetBytes: 1000,
    });
    expect(plan.droppedByRetentionCount).toBe(1);
    expect(plan.droppedByBudgetCount).toBe(1);
    expect(plan.retainedSampleCount).toBe(1);
  });

  it("⑥ 单条样本就超预算 ⇒ 全丢但**不抛错**（返回 0 条并说明）", () => {
    const plan = planProcessSampleRetention({
      samples: [sample(1, 5000)],
      nowIso: NOW_ISO,
      budgetBytes: 1000,
    });
    expect(plan.kind).toBe("trim-required");
    expect(plan.retainedSampleCount).toBe(0);
    expect(plan.droppedByBudgetCount).toBe(1);
    expect(plan.droppedBytes).toBe(5000);
  });

  it("⑦ 非法时间/坏时间戳 ⇒ 不猜测、不裁剪（fail-safe）", () => {
    expect(
      planProcessSampleRetention({ samples: [sample(1, 100)], nowIso: "not-a-time" }),
    ).toMatchObject({ kind: "no-action" });

    const planWithBadSample = planProcessSampleRetention({
      samples: [
        { recordedAtIso: "not-a-time", serializedBytes: 100 },
        sample(1, 100),
      ],
      nowIso: NOW_ISO,
    });
    // 无法解析时间的样本按过期处理（保守），并如实计数
    expect(planWithBadSample.droppedByRetentionCount).toBe(1);
    expect(planWithBadSample.retainedSampleCount).toBe(1);
  });
});
