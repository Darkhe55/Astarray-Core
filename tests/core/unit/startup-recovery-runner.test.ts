/**
 * 启动自动恢复 Phase 2（2026-11-05）：执行器（分批/并发/冷却/失败上限/sequence-only 跳过）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STARTUP_RECOVERY_POLICY,
  StartupRecoveryPolicyStore,
} from "../../../packages/core/src/orchestration/startup-recovery-policy.js";
import {
  StartupRecoveryAttemptStore,
  runStartupRecoveryPlan,
} from "../../../packages/core/src/orchestration/startup-recovery-runner.js";
import type {
  StartupRecoveryPlan,
  StartupRecoverySelectedEntry,
} from "../../../packages/core/src/orchestration/startup-recovery-scanner.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

function selected(
  missionIdentifier: string | null,
  taskIdentifier: string,
  kind: "mission-resume" | "sequence-only" = "mission-resume",
): StartupRecoverySelectedEntry {
  return {
    kind,
    missionIdentifier,
    sequenceIdentifier: "sequence-" + (missionIdentifier ?? "none"),
    taskIdentifier,
    ownerAgentInstanceIdentifier: "secondary-1",
    labels: ["unknown"],
    requiresNotification: false,
    reason: "test",
  };
}

function plan(entries: StartupRecoverySelectedEntry[]): StartupRecoveryPlan {
  return { selected: entries, skipped: [], candidateCount: entries.length, effectiveLimit: entries.length };
}

function policy(overrides: Partial<typeof DEFAULT_STARTUP_RECOVERY_POLICY> = {}) {
  return { ...DEFAULT_STARTUP_RECOVERY_POLICY, ...overrides };
}

describe("启动恢复执行器", () => {
  it("按并发分批、批间冷却；成功/失败分别记录；sequence-only 跳过", async () => {
    const attempts = new Map<string, number>([["m-maxed", 2]]);
    const sleep = vi.fn(async () => {});
    const resumeMission = vi.fn(async (missionIdentifier: string) => {
      if (missionIdentifier === "m-fail") throw new Error("恢复被拒（需对账）");
    });
    const recordAttempt = vi.fn(
      async (input: { missionIdentifier: string; outcome: "resumed" | "failed" }) => {
        if (input.outcome === "failed") {
          attempts.set(input.missionIdentifier, (attempts.get(input.missionIdentifier) ?? 0) + 1);
        } else {
          attempts.set(input.missionIdentifier, 0);
        }
      },
    );
    const report = await runStartupRecoveryPlan({
      plan: plan([
        selected("m-1", "t1"),
        selected("m-fail", "t2"),
        selected("m-3", "t3"),
        selected(null, "t4", "sequence-only"),
        selected("m-maxed", "t5"),
      ]),
      policy: policy({ maximumConcurrentResumes: 2, cooldownMilliseconds: 10 }),
      ports: {
        resumeMission,
        readAttemptCount: async (missionIdentifier) => attempts.get(missionIdentifier) ?? 0,
        recordAttempt,
        sleep,
        nowIso: () => "2026-11-05T12:00:00.000Z",
      },
    });
    expect(report.resumed).toEqual(["m-1", "m-3"]);
    expect(report.failed.map((entry) => entry.missionIdentifier)).toEqual(["m-fail"]);
    expect(report.failed[0]?.reason).toContain("需对账");
    expect(report.skipped.map((entry) => entry.reason).join("\n")).toContain("sequence-only");
    expect(report.skipped.map((entry) => entry.reason).join("\n")).toContain("已达上限");
    /** 3 个可恢复 mission、并发 2 ⇒ 2 批、批间冷却 1 次。 */
    expect(report.batchCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("失败次数持久化：达到上限后不再尝试", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-startup-attempts-"));
    directories.push(directory);
    const store = new StartupRecoveryAttemptStore({ baseDirectory: directory });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await store.recordAttempt({
        missionIdentifier: "m-1",
        outcome: "failed",
        reason: "rejected",
        attemptedAtIso: "2026-11-05T12:00:00.000Z",
      });
    }
    const record = await store.readAttempt("m-1");
    expect(record?.attemptCount).toBe(2);

    const report = await runStartupRecoveryPlan({
      plan: plan([selected("m-1", "t1")]),
      policy: policy({ maximumAttemptsPerTask: 2 }),
      ports: {
        resumeMission: async () => {
          throw new Error("不应被调用");
        },
        readAttemptCount: async () => 2,
        recordAttempt: async () => {},
        sleep: async () => {},
        nowIso: () => "2026-11-05T12:00:00.000Z",
      },
    });
    expect(report.resumed).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    expect(report.skipped[0]?.reason).toContain("已达上限");

    await store.recordAttempt({
      missionIdentifier: "m-1",
      outcome: "resumed",
      reason: null,
      attemptedAtIso: "2026-11-05T12:00:00.000Z",
    });
    expect((await store.readAttempt("m-1"))?.attemptCount).toBe(0);
  });

  it("策略与尝试存储可独立读写（Phase 2 依赖）", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-startup-policy2-"));
    directories.push(directory);
    const policyStore = new StartupRecoveryPolicyStore({ baseDirectory: directory });
    await policyStore.writePolicy(policy({ isEnabled: true, maximumResumePerStartup: 6 }));
    const reloaded = await policyStore.readPolicy();
    expect(reloaded.policy.maximumResumePerStartup).toBe(6);
    expect(reloaded.policy.maximumConcurrentResumes).toBe(1);
  });
});

describe("启动恢复 Phase 4：工作时段", () => {
  it("工作时段关闭 ⇒ 不调用 resumeMission，如实跳过", async () => {
    const resumeMission = vi.fn(async () => {});
    const report = await runStartupRecoveryPlan({
      plan: plan([selected("m-1", "t1")]),
      policy: policy(),
      ports: {
        resumeMission,
        readAttemptCount: async () => 0,
        recordAttempt: async () => {},
        sleep: async () => {},
        nowIso: () => "2026-11-05T12:00:00.000Z",
        readWorkWindowState: async () => ({ isOpen: false, reason: "22:00–08:00 休息" }),
      },
    });
    expect(resumeMission).not.toHaveBeenCalled();
    expect(report.skipped[0]?.reason).toContain("工作时段外");
  });
});
