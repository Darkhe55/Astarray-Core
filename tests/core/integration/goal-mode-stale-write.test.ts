/**
 * WIRING-04 §36.2 反例：目标状态的**陈旧写入必须被拒**（2026-11-18）。
 *
 * 顺序用代码确定，不靠睡眠：A 先读（持有 revision N）→ B 提交 N+1 →
 * A 用旧 revision 提交 ⇒ 必须拿到显式冲突，磁盘保留 B 的结果。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GoalModeStateStore,
  type PersistedGoalModeState,
} from "../../../packages/core/src/orchestration/goal-mode-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "goal-mode-cas-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): GoalModeStateStore {
  return new GoalModeStateStore({ baseDirectory: stateDirectory });
}

function buildState(
  documentRevision: number,
  overrides: Partial<PersistedGoalModeState> = {},
): PersistedGoalModeState {
  return {
    schemaVersion: 1,
    documentRevision,
    goalIdentifier: "goal-1",
    contractRevision: 1,
    ownerIdentifier: "user-1",
    sourceRequestReference: "request-1",
    requirementBases: [],
    lastPotentialValue: null,
    currentTaskGroupIdentifier: documentRevision === 1 ? "group-1" : null,
    currentTaskGroupStartedAtIso: null,
    consumedToolCalls: 0,
    evidenceGaps: [],
    requiresReplanning: false,
    pauseReason: null,
    isExperimentClosed: false,
    closedAtIso: null,
    updatedAtIso: "2026-11-18T00:00:00.000Z",
    ...overrides,
  } as PersistedGoalModeState;
}

describe("WIRING-04 §36.2：目标状态的陈旧写入", () => {
  it("① A 持旧 revision 提交 ⇒ 显式冲突，磁盘保留 B 的结果", async () => {
    const storeA = buildStore();
    const storeB = buildStore();

    /** 初始：revision 1。 */
    const initialWrite = await storeA.writeIfDocumentRevision({
      state: buildState(1),
      expectedDocumentRevision: 0,
    });
    expect(initialWrite.outcome).toBe("written");

    /** A 先读：拿到 revision 1（这是它之后要用的"旧值"）。 */
    const stateReadByA = await storeA.read("goal-1");
    expect(stateReadByA?.documentRevision).toBe(1);

    /** B 提交：1 → 2，且标记实验关闭（最终裁决）。 */
    const bWrite = await storeB.writeIfDocumentRevision({
      state: buildState(2, { isExperimentClosed: true, pauseReason: "B 的裁决" }),
      expectedDocumentRevision: 1,
    });
    expect(bWrite.outcome).toBe("written");

    /** A 用**旧的 revision 1** 提交：必须冲突。 */
    const staleWrite = await storeA.writeIfDocumentRevision({
      state: buildState(2, { isExperimentClosed: false, pauseReason: "A 的旧状态" }),
      expectedDocumentRevision: 1,
    });
    expect(staleWrite.outcome).toBe("conflict");
    expect(staleWrite.currentDocumentRevision).toBe(2);

    /** 磁盘仍是 B 的裁决。 */
    const reloaded = await buildStore().read("goal-1");
    expect(reloaded?.documentRevision).toBe(2);
    expect(reloaded?.isExperimentClosed).toBe(true);
    expect(reloaded?.pauseReason).toBe("B 的裁决");
  }, 60_000);

  it("② beginTaskGroup 用旧状态提交 ⇒ 抛 stale-revision（不静默覆盖）", async () => {
    const storeA = buildStore();
    const storeB = buildStore();
    await storeA.writeIfDocumentRevision({ state: buildState(1), expectedDocumentRevision: 0 });
    const stateReadByA = await storeA.read("goal-1");
    if (stateReadByA === null) {
      throw new Error("初始状态应存在");
    }
    /** B 先推进到 revision 2。 */
    await storeB.writeIfDocumentRevision({
      state: buildState(2, { isExperimentClosed: true }),
      expectedDocumentRevision: 1,
    });

    await expect(
      storeA.beginTaskGroup({
        state: stateReadByA,
        taskGroupIdentifier: "group-2",
        startedAtIso: "2026-11-18T00:00:02.000Z",
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  }, 60_000);
});
