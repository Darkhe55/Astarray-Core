/**
 * 可评估暂停条件清单（此前 `tests/` 零引用）。
 *
 * 清单是**冻结枚举**：只有列在这里的条件会被评估；未知字符串必须被契约校验拒绝，
 * 否则"写了条件但其实没人看"——这是这张卡当初要解决的缺口。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoalContractStore } from "../../../packages/core/src/orchestration/goal-contract-store.js";
import {
  GOAL_CONTRACT_SCHEMA_VERSION,
  validateGoalContract,
} from "../../../packages/core/src/orchestration/goal-contract.js";
import {
  GOAL_PAUSE_CONDITIONS,
  isKnownGoalPauseCondition,
} from "../../../packages/core/src/orchestration/goal-pause-condition-catalog.js";
import type { GoalContract } from "../../../packages/core/src/orchestration/goal-contract.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pause-catalog-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildContract(pauseConditions: readonly string[]): GoalContract {
  return {
    schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
    goalIdentifier: "goal-1",
    revision: 1,
    ownerIdentifier: "user-1",
    sourceRequestReference: "user-message-1",
    objectiveText: "把文档补完",
    scope: { projectIdentifiers: [], allowedToolNames: null },
    nonViolableInvariants: [],
    requirements: [
      {
        requirementIdentifier: "req-1",
        description: "写完说明",
        weight: 1,
        completionPredicateKind: "deterministic-check",
      },
    ],
    resourceLimits: {
      maximumToolCalls: null,
      maximumWallClockSeconds: null,
      maximumCostUnits: null,
    },
    deadlineIso: null,
    pauseConditions,
    supersedesRevision: null,
  } as never;
}

describe("暂停条件清单", () => {
  it("① 清单冻结为四个可评估条件", () => {
    expect([...GOAL_PAUSE_CONDITIONS]).toEqual([
      "budget-exhausted",
      "deadline-passed",
      "stagnation",
      "requires-replanning",
    ]);
  });

  it("② 已知条件逐个识别为已知", () => {
    for (const condition of GOAL_PAUSE_CONDITIONS) {
      expect(isKnownGoalPauseCondition(condition)).toBe(true);
    }
  });

  it("③ 未知 / 大小写变体 / 带空格 / 空串 一律不是已知（不得模糊匹配）", () => {
    for (const unknown of [
      "budget-exhausted ",
      " BUDGET-EXHAUSTED",
      "Budget-Exhausted",
      "tool-budget-exhausted",
      "",
      "任意中文条件",
    ]) {
      expect(isKnownGoalPauseCondition(unknown)).toBe(false);
    }
  });

  it("④ 清单无重复", () => {
    expect(new Set(GOAL_PAUSE_CONDITIONS).size).toBe(GOAL_PAUSE_CONDITIONS.length);
  });

  it("⑤ 契约校验拒绝未知暂停条件（目录真的被使用）", () => {
    const rejected = validateGoalContract(buildContract(["unknown-condition"]));
    expect(rejected.isValid).toBe(false);
    if (rejected.isValid) throw new Error("期望非法：未知暂停条件必须被拒");
    expect(rejected.reasons.join("|")).toContain("未知的暂停条件");

    const accepted = validateGoalContract(buildContract(["stagnation", "deadline-passed"]));
    expect(accepted.isValid).toBe(true);
  });

  it("⑥ 端到端：未知条件的目标契约拒绝落盘且不留文件", async () => {
    const store = new GoalContractStore({ baseDirectory });
    await expect(store.save(buildContract(["unknown-condition"]))).rejects.toThrow(/非法/u);
    expect(await store.list()).toEqual([]);
  });
});
