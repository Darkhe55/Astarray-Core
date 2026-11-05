/**
 * 启动自动恢复（2026-11-05，口径按用户修订）：策略 + 自适应上限 + 扫描 + 选择。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STARTUP_RECOVERY_POLICY,
  StartupRecoveryPolicyStore,
  parseStartupRecoveryPolicy,
} from "../../../packages/core/src/orchestration/startup-recovery-policy.js";
import { computeAdaptiveResumeLimit } from "../../../packages/core/src/orchestration/startup-recovery-capacity.js";
import {
  evaluateStartupRecoveryCandidate,
  scanStartupRecoveryCandidates,
  selectStartupRecoveryPlan,
  type StartupRecoveryCandidateView,
} from "../../../packages/core/src/orchestration/startup-recovery-scanner.js";

const NOW = "2026-11-05T12:00:00.000Z";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

function makeView(
  overrides: Partial<StartupRecoveryCandidateView> = {},
): StartupRecoveryCandidateView {
  return {
    kind: "mission-resume",
    missionIdentifier: "mission-1",
    missionStatus: "running",
    missionMode: "assist",
    projectIdentifier: "project-a",
    conversationIdentifier: "conversation-1",
    sequenceIdentifier: "sequence-secondary-1",
    taskIdentifier: "task-mission-1",
    sequenceOwnerAgentInstanceIdentifier: "secondary-1",
    sequenceTaskStatus: "running",
    priorityTier: 0,
    sequenceOrdinal: 1,
    leaseExpiresAtIso: "2026-11-05T11:00:00.000Z",
    labels: ["unknown"],
    ...overrides,
  };
}

function policy(overrides: Partial<typeof DEFAULT_STARTUP_RECOVERY_POLICY> = {}) {
  return { ...DEFAULT_STARTUP_RECOVERY_POLICY, ...overrides };
}

describe("启动恢复策略（修订口径）", () => {
  it("默认：关闭、8 个上限、1 并发、动态、含写默认恢复但提示", () => {
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.isEnabled).toBe(false);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.maximumResumePerStartup).toBe(8);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.minimumResumePerStartup).toBe(1);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.isLoadAdaptive).toBe(true);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.allowedTaskLabels).toContain("has-writes");
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.requireConfirmationFor).toEqual([]);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.notifyOnAutoResume).toBe(true);
  });

  it("非法值直接拒绝（不静默 clamp）", () => {
    expect(() => parseStartupRecoveryPolicy({ maximumResumePerStartup: 99 })).toThrow(
      /1\.\.50/u,
    );
    expect(() =>
      parseStartupRecoveryPolicy({
        maximumResumePerStartup: 5,
        minimumResumePerStartup: 6,
      }),
    ).toThrow(/不能大于/u);
    expect(() => parseStartupRecoveryPolicy({ targetCpuUtilization: 1 })).toThrow(
      /\(0,1\)/u,
    );
  });

  it("未落盘 ⇒ 默认且 isPersisted=false；写入后可读回", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-startup-recovery-"));
    directories.push(directory);
    const store = new StartupRecoveryPolicyStore({ baseDirectory: directory });
    const initial = await store.readPolicy();
    expect(initial.isPersisted).toBe(false);
    expect(initial.policy).toEqual(DEFAULT_STARTUP_RECOVERY_POLICY);
    await store.writePolicy(policy({ isEnabled: true, maximumResumePerStartup: 5 }));
    const reloaded = await store.readPolicy();
    expect(reloaded.isPersisted).toBe(true);
    expect(reloaded.policy.maximumResumePerStartup).toBe(5);
  });
});

describe("动态上限", () => {
  it("空载 ⇒ 上限；压力达到目标 ⇒ 下界；中间线性", () => {
    const base = policy();
    const idle = computeAdaptiveResumeLimit(base, {
      cpuCount: 8,
      loadAverage1m: 0,
      freeMemoryBytes: 1000,
      totalMemoryBytes: 1000,
    });
    expect(idle.effectiveLimit).toBe(8);

    const busy = computeAdaptiveResumeLimit(base, {
      cpuCount: 8,
      loadAverage1m: 8,
      freeMemoryBytes: 100,
      totalMemoryBytes: 1000,
    });
    expect(busy.effectiveLimit).toBe(1);

    const middle = computeAdaptiveResumeLimit(base, {
      cpuCount: 8,
      loadAverage1m: 0,
      freeMemoryBytes: 500,
      totalMemoryBytes: 1000,
    });
    expect(middle.effectiveLimit).toBeGreaterThan(1);
    expect(middle.effectiveLimit).toBeLessThan(8);
  });

  it("关闭动态 ⇒ 直接使用上限", () => {
    const decision = computeAdaptiveResumeLimit(
      policy({ isLoadAdaptive: false }),
      {
        cpuCount: 1,
        loadAverage1m: 99,
        freeMemoryBytes: 0,
        totalMemoryBytes: 1000,
      },
    );
    expect(decision.effectiveLimit).toBe(8);
  });
});

describe("候选判定（未完成即可恢复）", () => {
  it("pending 也算可恢复（用户口径：序列里未完成的内容）", () => {
    expect(
      evaluateStartupRecoveryCandidate(makeView({ sequenceTaskStatus: "pending" }), NOW)
        .isResumable,
    ).toBe(true);
  });

  it("租约有效 / 终态 / 序列终态 跳过", () => {
    expect(
      evaluateStartupRecoveryCandidate(
        makeView({ leaseExpiresAtIso: "2026-11-05T12:05:00.000Z" }),
        NOW,
      ).isResumable,
    ).toBe(false);
    expect(
      evaluateStartupRecoveryCandidate(makeView({ missionStatus: "done" }), NOW)
        .isResumable,
    ).toBe(false);
    expect(
      evaluateStartupRecoveryCandidate(makeView({ sequenceTaskStatus: "done" }), NOW)
        .isResumable,
    ).toBe(false);
  });

  it("序列独有任务（无 mission）也可恢复", () => {
    expect(
      evaluateStartupRecoveryCandidate(
        makeView({
          kind: "sequence-only",
          missionIdentifier: null,
          missionStatus: null,
          leaseExpiresAtIso: null,
          sequenceTaskStatus: "pending",
        }),
        NOW,
      ).isResumable,
    ).toBe(true);
  });
});

describe("选择与报告", () => {
  it("关闭时只扫描：全部跳过", () => {
    const plan = selectStartupRecoveryPlan({
      views: [makeView()],
      policy: policy({ isEnabled: false }),
      effectiveLimit: 0,
      nowIso: NOW,
    });
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain("已关闭");
  });

  it("按优先级/中断时间排序，并按动态上限截断", () => {
    const plan = selectStartupRecoveryPlan({
      views: [
        makeView({ missionIdentifier: "m-low", priorityTier: 1 }),
        makeView({
          missionIdentifier: "m-mid",
          priorityTier: 0,
          leaseExpiresAtIso: "2026-11-05T11:30:00.000Z",
        }),
        makeView({
          missionIdentifier: "m-high",
          priorityTier: 0,
          leaseExpiresAtIso: "2026-11-05T11:10:00.000Z",
        }),
      ],
      policy: policy({ isEnabled: true }),
      effectiveLimit: 2,
      nowIso: NOW,
    });
    expect(plan.selected.map((entry) => entry.missionIdentifier)).toEqual([
      "m-high",
      "m-mid",
    ]);
    expect(
      plan.skipped.find((entry) => entry.missionIdentifier === "m-low")?.reason,
    ).toContain("动态上限");
  });

  it("含写任务默认恢复但 requiresNotification=true；显式允许空标签时跳过", () => {
    const plan = selectStartupRecoveryPlan({
      views: [
        makeView({ missionIdentifier: "m-writes", labels: ["has-writes"] }),
        makeView({ missionIdentifier: "m-goal", labels: ["goal"] }),
      ],
      policy: policy({ isEnabled: true }),
      effectiveLimit: 5,
      nowIso: NOW,
    });
    expect(plan.selected).toHaveLength(2);
    expect(
      plan.selected.find((entry) => entry.missionIdentifier === "m-writes")
        ?.requiresNotification,
    ).toBe(true);

    const restricted = selectStartupRecoveryPlan({
      views: [makeView({ labels: ["unknown"] })],
      policy: policy({ isEnabled: true, allowedTaskLabels: ["normal"] }),
      effectiveLimit: 5,
      nowIso: NOW,
    });
    expect(restricted.selected).toHaveLength(0);
  });
});

describe("只读扫描", () => {
  it("聚合 mission 关系 + 序列独有任务，不恢复", async () => {
    const report = await scanStartupRecoveryCandidates({
      policy: policy({ isEnabled: true }),
      capacitySample: {
        cpuCount: 8,
        loadAverage1m: 0,
        freeMemoryBytes: 800,
        totalMemoryBytes: 1000,
      },
      nowIso: NOW,
      ports: {
        listMissionRelations: async () => [
          {
            missionIdentifier: "mission-1",
            projectIdentifier: "project-a",
            conversationIdentifier: "conversation-1",
            taskSequenceIdentifier: "sequence-secondary-1",
            taskIdentifier: "task-mission-1",
            sequenceOwnerAgentInstanceIdentifier: "secondary-1",
          },
        ],
        readMissionSummary: async () => ({ status: "running", mode: "assist" }),
        readLeaseExpiresAtIso: async () => "2026-11-05T11:00:00.000Z",
        readSequenceTask: async () => ({
          status: "pending",
          priorityTier: 0,
          sequenceOrdinal: 2,
        }),
        listSequenceTasks: async () => [
          {
            ownerAgentInstanceIdentifier: "secondary-2",
            sequenceIdentifier: "sequence-secondary-2",
            taskIdentifier: "task-only-1",
            status: "blocked",
            priorityTier: 1,
            sequenceOrdinal: 3,
          },
        ],
      },
    });
    expect(report.views).toHaveLength(2);
    expect(report.selected).toHaveLength(2);
    expect(report.selected.some((entry) => entry.kind === "sequence-only")).toBe(true);
  });
});
