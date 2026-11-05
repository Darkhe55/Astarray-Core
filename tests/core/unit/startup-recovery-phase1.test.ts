/**
 * 启动自动恢复 Phase 1（2026-11-05）：策略 + 只读扫描 + 选择。
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
    labels: ["normal"],
    ...overrides,
  };
}

describe("启动恢复策略", () => {
  it("默认值：关闭、每次最多 3、并发 1、含写需确认", () => {
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.isEnabled).toBe(false);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.maximumResumePerStartup).toBe(3);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.maximumConcurrentResumes).toBe(1);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.allowedTaskLabels).toEqual(["normal"]);
    expect(DEFAULT_STARTUP_RECOVERY_POLICY.requireConfirmationFor).toContain("has-writes");
  });

  it("非法值直接拒绝（不静默 clamp）", () => {
    expect(() => parseStartupRecoveryPolicy({ maximumResumePerStartup: 99 })).toThrow(
      /0\.\.20/u,
    );
    expect(() => parseStartupRecoveryPolicy({ allowedTaskLabels: ["nope"] })).toThrow(
      /未知标签/u,
    );
    expect(() => parseStartupRecoveryPolicy({ isEnabled: "yes" })).toThrow(/布尔值/u);
  });

  it("未落盘 ⇒ 返回默认且 isPersisted=false；写入后可读回", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-startup-recovery-"));
    directories.push(directory);
    const store = new StartupRecoveryPolicyStore({ baseDirectory: directory });
    const initial = await store.readPolicy();
    expect(initial.isPersisted).toBe(false);
    expect(initial.policy).toEqual(DEFAULT_STARTUP_RECOVERY_POLICY);

    const written = await store.writePolicy({
      ...DEFAULT_STARTUP_RECOVERY_POLICY,
      isEnabled: true,
      maximumResumePerStartup: 5,
    });
    expect(written.isEnabled).toBe(true);
    const reloaded = await store.readPolicy();
    expect(reloaded.isPersisted).toBe(true);
    expect(reloaded.policy.maximumResumePerStartup).toBe(5);
  });
});

describe("启动恢复候选判定", () => {
  it("租约仍有效 ⇒ 不恢复", () => {
    const decision = evaluateStartupRecoveryCandidate(
      makeView({ leaseExpiresAtIso: "2026-11-05T12:05:00.000Z" }),
      NOW,
    );
    expect(decision.isResumable).toBe(false);
    expect(decision.skippedReason).toContain("租约仍有效");
  });

  it("终态 / 缺映射 / 非可恢复状态均跳过", () => {
    expect(
      evaluateStartupRecoveryCandidate(makeView({ missionStatus: "done" }), NOW)
        .skippedReason,
    ).toContain("终态");
    expect(
      evaluateStartupRecoveryCandidate(
        makeView({ sequenceIdentifier: null }),
        NOW,
      ).skippedReason,
    ).toContain("缺少序列");
    expect(
      evaluateStartupRecoveryCandidate(
        makeView({ sequenceTaskStatus: "pending" }),
        NOW,
      ).skippedReason,
    ).toContain("不属于被中断");
  });
});

describe("启动恢复选择", () => {
  it("关闭时只扫描：全部跳过，selected 为空", () => {
    const plan = selectStartupRecoveryPlan({
      views: [makeView(), makeView({ missionIdentifier: "mission-2" })],
      policy: {
        isEnabled: false,
        maximumResumePerStartup: 3,
        maximumConcurrentResumes: 1,
        allowedTaskLabels: ["normal"],
        requireConfirmationFor: [],
      },
      nowIso: NOW,
    });
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped.every((entry) => entry.reason.includes("已关闭"))).toBe(true);
  });

  it("按优先级/中断时间排序，并按上限截断", () => {
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
      policy: {
        isEnabled: true,
        maximumResumePerStartup: 2,
        maximumConcurrentResumes: 1,
        allowedTaskLabels: ["normal"],
        requireConfirmationFor: [],
      },
      nowIso: NOW,
    });
    expect(plan.selected.map((entry) => entry.missionIdentifier)).toEqual([
      "m-high",
      "m-mid",
    ]);
    expect(
      plan.skipped.find((entry) => entry.missionIdentifier === "m-low")?.reason,
    ).toContain("超出本次启动上限");
  });

  it("类型不允许 / 需确认 ⇒ 跳过", () => {
    const plan = selectStartupRecoveryPlan({
      views: [
        makeView({ missionIdentifier: "m-writes", labels: ["has-writes"] }),
        makeView({ missionIdentifier: "m-unknown", labels: ["unknown"] }),
      ],
      policy: {
        isEnabled: true,
        maximumResumePerStartup: 3,
        maximumConcurrentResumes: 1,
        allowedTaskLabels: ["normal"],
        requireConfirmationFor: [],
      },
      nowIso: NOW,
    });
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped.map((entry) => entry.reason).join("\n")).toContain("类型未允许");
  });
});

describe("启动恢复只读扫描", () => {
  it("从关系索引/租约/序列读取候选，不恢复", async () => {
    const report = await scanStartupRecoveryCandidates({
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
        readSequenceTask: async (input) => {
          expect(input.ownerAgentInstanceIdentifier).toBe("secondary-1");
          expect(input.viewer).toEqual({
            sourceKind: "agent",
            actorId: "secondary-1",
          });
          return { status: "running", priorityTier: 0, sequenceOrdinal: 2 };
        },
      },
      policy: {
        isEnabled: true,
        maximumResumePerStartup: 3,
        maximumConcurrentResumes: 1,
        allowedTaskLabels: ["normal"],
        requireConfirmationFor: [],
      },
      nowIso: NOW,
    });
    expect(report.views).toHaveLength(1);
    expect(report.views[0]?.sequenceTaskStatus).toBe("running");
    /** Phase 1 标签恒为 unknown ⇒ 默认策略不会选中。 */
    expect(report.selected).toHaveLength(0);
    expect(report.skipped[0]?.reason).toContain("类型未允许");
  });
});
