/**
 * 目标契约存储（此前 `tests/` 零引用）：**非法契约拒绝落盘**、**未激活不得创建**、损坏读回 null。
 *
 * 反例优先：非法契约不仅要被拒，还**不能留下文件**；激活判定交给 `resolveGoalModeActivation`，
 * 模型来源 / 非显式请求一律拒绝（目标模式不得由模型自己开）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoalContractStore } from "../../../packages/core/src/orchestration/goal-contract-store.js";
import { GOAL_CONTRACT_SCHEMA_VERSION } from "../../../packages/core/src/orchestration/goal-contract.js";
import type { GoalContract } from "../../../packages/core/src/orchestration/goal-contract.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "goal-contract-store-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildContract(overrides: Record<string, unknown> = {}): GoalContract {
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
    pauseConditions: [],
    supersedesRevision: null,
    ...overrides,
  } as never;
}

describe("目标契约存储", () => {
  it("① 非法契约 ⇒ 拒绝落盘，且不留下文件", async () => {
    const store = new GoalContractStore({ baseDirectory });
    await expect(store.save(buildContract({ requirements: [] }))).rejects.toThrow(/非法/u);
    expect(await store.list()).toEqual([]);
    expect(await store.read("goal-1")).toBeNull();
  });

  it("② 合法契约 ⇒ 落盘并可读回（深相等）", async () => {
    const store = new GoalContractStore({ baseDirectory });
    const contract = buildContract();
    await store.save(contract);
    expect(await store.read("goal-1")).toEqual(contract);
  });

  it("③ 未知 goal ⇒ null；损坏/缺字段文件 ⇒ null（不伪造契约）", async () => {
    const store = new GoalContractStore({ baseDirectory });
    expect(await store.read("goal-missing")).toBeNull();

    const contractsDirectory = path.join(baseDirectory, "goal-mode", "contracts");
    await fs.mkdir(contractsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(contractsDirectory, "goal-broken.json"),
      JSON.stringify({ goalIdentifier: "goal-broken" }),
      "utf8",
    );
    expect(await store.read("goal-broken")).toBeNull();
  });

  it("④ saveActivated：模型来源 ⇒ 拒绝（目标模式不得由模型自开）", async () => {
    const store = new GoalContractStore({ baseDirectory });
    await expect(
      store.saveActivated(buildContract(), {
        isExplicitUserRequest: true,
        isAuthenticatedUser: true,
        isExplicitlyEnabled: true,
        requestedBy: "model",
      }),
    ).rejects.toThrow(/未激活/u);
    expect(await store.list()).toEqual([]);
  });

  it("⑤ saveActivated：非显式用户请求 ⇒ 拒绝", async () => {
    const store = new GoalContractStore({ baseDirectory });
    await expect(
      store.saveActivated(buildContract(), {
        isExplicitUserRequest: false,
        isAuthenticatedUser: true,
        isExplicitlyEnabled: true,
        requestedBy: "user",
      }),
    ).rejects.toThrow(/未激活/u);
  });

  it("⑥ saveActivated：认证用户 + 显式请求 + 显式开启 ⇒ 落盘并返回激活原因", async () => {
    const store = new GoalContractStore({ baseDirectory });
    const result = await store.saveActivated(buildContract(), {
      isExplicitUserRequest: true,
      isAuthenticatedUser: true,
      isExplicitlyEnabled: true,
      requestedBy: "user",
    });
    expect(result.isActive).toBe(true);
    expect(result.reason.length).toBeGreaterThan(0);
    expect((await store.read("goal-1"))?.objectiveText).toBe("把文档补完");
  });

  it("⑦ list：只返回合法契约，损坏的被跳过；目录不存在 ⇒ 空", async () => {
    const store = new GoalContractStore({ baseDirectory });
    expect(await store.list()).toEqual([]);

    await store.save(buildContract({ goalIdentifier: "goal-a" }));
    await store.save(buildContract({ goalIdentifier: "goal-b" }));
    const contractsDirectory = path.join(baseDirectory, "goal-mode", "contracts");
    await fs.writeFile(
      path.join(contractsDirectory, "goal-broken.json"),
      JSON.stringify({ goalIdentifier: "goal-broken" }),
      "utf8",
    );
    const listed = await store.list();
    expect(listed.map((contract) => contract.goalIdentifier).sort()).toEqual(["goal-a", "goal-b"]);
  });
});
