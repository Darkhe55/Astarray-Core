/**
 * R73（2026-10-31）：K1 目标提案与用户确认的单测。
 *
 * 覆盖：提案校验（空目标/无要求/重复标识/非正权重/过期）、提案→契约转换（revision 1、
 * 来源引用与权重保留、任务节点留空）、以及"一份提案只能生成一个目标"的存储规则。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GoalContractProposalStore,
  buildGoalContractFromProposal,
  validateGoalProposal,
} from "../../packages/core/src/orchestration/goal-contract-proposal.js";
import type { GoalContractProposal } from "../../packages/core/src/orchestration/goal-contract-proposal.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function buildProposal(overrides: Partial<GoalContractProposal> = {}): GoalContractProposal {
  return {
    schemaVersion: 1,
    proposalIdentifier: "goal-proposal-1",
    sourceRequestReference: "user-message-1",
    draft: {
      objectiveText: "把文档补完",
      requirements: [
        {
          requirementIdentifier: "req-1",
          description: "写完说明",
          weight: 1,
          completionPredicateKind: "deterministic-check",
        },
      ],
      scope: { projectIdentifiers: [], allowedToolNames: null },
      nonViolableInvariants: [],
      resourceLimits: {
        maximumToolCalls: null,
        maximumWallClockSeconds: null,
        maximumCostUnits: null,
      },
      deadlineIso: null,
      pauseConditions: [],
    },
    createdAtIso: "2026-10-31T00:00:00.000Z",
    expiresAtIso: "2026-10-31T00:30:00.000Z",
    confirmedAtIso: null,
    confirmedGoalIdentifier: null,
    ...overrides,
  };
}

describe("validateGoalProposal", () => {
  it("合法提案通过", () => {
    const result = validateGoalProposal({
      proposal: buildProposal(),
      nowIso: "2026-10-31T00:10:00.000Z",
    });
    expect(result.reasons).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("空目标 / 无要求 / 重复标识 / 非正权重 分别被拒", () => {
    const emptyObjective = buildProposal({
      draft: { ...buildProposal().draft, objectiveText: "  " },
    });
    const noRequirements = buildProposal({
      draft: { ...buildProposal().draft, requirements: [] },
    });
    const duplicated = buildProposal({
      draft: {
        ...buildProposal().draft,
        requirements: [
          buildProposal().draft.requirements[0]!,
          buildProposal().draft.requirements[0]!,
        ],
      },
    });
    const negativeWeight = buildProposal({
      draft: {
        ...buildProposal().draft,
        requirements: [{ ...buildProposal().draft.requirements[0]!, weight: 0 }],
      },
    });
    for (const proposal of [emptyObjective, noRequirements, duplicated, negativeWeight]) {
      const result = validateGoalProposal({
        proposal,
        nowIso: "2026-10-31T00:10:00.000Z",
      });
      expect(result.isValid).toBe(false);
    }
  });

  it("过期提案被拒", () => {
    const result = validateGoalProposal({
      proposal: buildProposal(),
      nowIso: "2026-10-31T01:00:00.000Z",
    });
    expect(result.isValid).toBe(false);
    expect(result.reasons.join("；")).toContain("已过期");
  });
});

describe("buildGoalContractFromProposal", () => {
  it("生成 revision 1 契约：保留来源/权重，任务节点留空，supersedes 为 null", () => {
    const contract = buildGoalContractFromProposal({
      proposal: buildProposal(),
      goalIdentifier: "goal-a",
      ownerIdentifier: "owner-1",
    });
    expect(contract.revision).toBe(1);
    expect(contract.supersedesRevision).toBeNull();
    expect(contract.sourceRequestReference).toBe("user-message-1");
    expect(contract.requirements[0]?.weight).toBe(1);
    expect(contract.requirements[0]?.taskNodeIdentifiers).toEqual([]);
    expect(contract.ownerIdentifier).toBe("owner-1");
  });

  it("缺少所有者 ⇒ 拒绝（目标必须绑定认证用户）", () => {
    expect(() =>
      buildGoalContractFromProposal({
        proposal: buildProposal(),
        goalIdentifier: "goal-a",
        ownerIdentifier: " ",
      }),
    ).toThrow();
  });
});

describe("GoalContractProposalStore", () => {
  async function createStore(): Promise<GoalContractProposalStore> {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-goal-proposal-"));
    directories.push(directory);
    return new GoalContractProposalStore({ baseDirectory: directory });
  }

  it("保存后可读回；确认后写入确认信息", async () => {
    const store = await createStore();
    const proposal = buildProposal();
    await store.save(proposal);
    expect((await store.read(proposal.proposalIdentifier))?.confirmedAtIso).toBeNull();

    const confirmed = await store.markConfirmed({
      proposalIdentifier: proposal.proposalIdentifier,
      confirmedGoalIdentifier: "goal-a",
      confirmedAtIso: "2026-10-31T00:05:00.000Z",
    });
    expect(confirmed.confirmedGoalIdentifier).toBe("goal-a");
    expect((await store.read(proposal.proposalIdentifier))?.confirmedAtIso).toBe(
      "2026-10-31T00:05:00.000Z",
    );
  });

  it("同一提案重复确认同一目标 ⇒ 幂等；换成另一个目标 ⇒ 拒绝", async () => {
    const store = await createStore();
    const proposal = buildProposal();
    await store.save(proposal);
    await store.markConfirmed({
      proposalIdentifier: proposal.proposalIdentifier,
      confirmedGoalIdentifier: "goal-a",
      confirmedAtIso: "2026-10-31T00:05:00.000Z",
    });
    const again = await store.markConfirmed({
      proposalIdentifier: proposal.proposalIdentifier,
      confirmedGoalIdentifier: "goal-a",
      confirmedAtIso: "2026-10-31T00:06:00.000Z",
    });
    expect(again.confirmedGoalIdentifier).toBe("goal-a");

    await expect(
      store.markConfirmed({
        proposalIdentifier: proposal.proposalIdentifier,
        confirmedGoalIdentifier: "goal-b",
        confirmedAtIso: "2026-10-31T00:07:00.000Z",
      }),
    ).rejects.toThrow();
  });
});
