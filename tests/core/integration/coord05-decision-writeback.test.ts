/**
 * COORD-05 05-05（2026-11-22）：决定写回与恢复。
 *
 * 覆盖：写回+推进、崩溃点 A（已回答未写回）、崩溃点 B（已写回未推进）、
 * 重复调用不多推进、取消的 mission 不重启、文档 revision 冲突保留决定、
 * 只推进显式依赖该决定的步骤。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DecisionWritebackStore,
  applyDecisionWriteback,
  type DecisionWritebackPorts,
  type DecisionWritebackRecord,
} from "../../../packages/core/src/orchestration/decision-writeback.js";

let baseDirectory: string;
let store: DecisionWritebackStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-05-"));
  store = new DecisionWritebackStore({ baseDirectory });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function record(overrides: Partial<DecisionWritebackRecord> = {}): DecisionWritebackRecord {
  return {
    decisionIdentifier: "decision-1",
    escalationRequestIdentifier: "escalation-1",
    projectIdentifier: "p1",
    missionIdentifier: "m-1",
    taskIdentifier: "T-1",
    source: "user",
    summary: "采用方案 A",
    affectedStepIdentifiers: ["step-export"],
    status: "answered",
    documentRevision: null,
    advancedStepIdentifiers: [],
    createdAtIso: "2026-11-22T00:00:00.000Z",
    updatedAtIso: "2026-11-22T00:00:00.000Z",
    ...overrides,
  };
}

function makePorts(options: {
  documentRevision?: number;
  missionStatus?: "running" | "cancelled" | "completed" | "unknown";
  writeError?: boolean;
  steps?: Array<{
    stepIdentifier: string;
    status: "pending" | "running" | "done" | "failed" | "waiting-on-decision";
    dependsOnDecisionIdentifiers: string[];
  }>;
}) {
  const writes: Array<{ decisionIdentifier: string; expectedRevision: number | null }> = [];
  const advanced: string[] = [];
  const ports: DecisionWritebackPorts = {
    readDocumentRevision: async () => options.documentRevision ?? 1,
    writeDecision: async (input) => {
      writes.push({
        decisionIdentifier: input.decisionIdentifier,
        expectedRevision: input.expectedRevision,
      });
      if (options.writeError === true) {
        throw new Error("文档暂时不可写");
      }
      return { documentRevision: options.documentRevision ?? 1 };
    },
    readMissionState: async () => ({
      status: options.missionStatus ?? "running",
      steps:
        options.steps ??
        [
          {
            stepIdentifier: "step-export",
            status: "waiting-on-decision",
            dependsOnDecisionIdentifiers: ["decision-1"],
          },
          {
            stepIdentifier: "step-other",
            status: "pending",
            dependsOnDecisionIdentifiers: [],
          },
        ],
    }),
    advanceStep: async (stepIdentifier) => {
      advanced.push(stepIdentifier);
    },
  };
  return { ports, writes, advanced };
}

describe("COORD-05 05-05：决定写回与恢复", () => {
  it("① 回答 ⇒ 写回权威文档并只推进显式依赖的步骤", async () => {
    await store.recordAnswer(record());
    const { ports, writes, advanced } = makePorts({});
    const outcome = await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:01:00.000Z" },
    );
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(writes).toHaveLength(1);
    expect(advanced).toEqual(["step-export"]);
    expect(outcome.record.status).toBe("advanced");
    expect(outcome.record.documentRevision).toBe(1);
    expect(outcome.record.advancedStepIdentifiers).toEqual(["step-export"]);
  });

  it("② 崩溃点 A：写回失败 ⇒ 保持 answered；重试补写并推进一次", async () => {
    await store.recordAnswer(record());
    const failing = makePorts({ writeError: true });
    const first = await applyDecisionWriteback(
      { store, ports: failing.ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:01:00.000Z" },
    );
    expect(first.kind).toBe("deferred");
    const persisted = (await store.list())[0];
    expect(persisted?.status).toBe("answered");

    const retry = makePorts({});
    const second = await applyDecisionWriteback(
      { store, ports: retry.ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:02:00.000Z" },
    );
    expect(second.kind).toBe("advanced");
    expect(retry.writes).toHaveLength(1);
    expect(retry.advanced).toEqual(["step-export"]);
  });

  it("③ 崩溃点 B：已写回未推进 ⇒ 重试只推进，不重复写文档", async () => {
    await store.recordAnswer(record());
    await store.update("decision-1", (candidate) => ({
      ...candidate,
      status: "written-back",
      documentRevision: 1,
    }));
    const { ports, writes, advanced } = makePorts({});
    const outcome = await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:03:00.000Z" },
    );
    expect(outcome.kind).toBe("advanced");
    expect(writes).toHaveLength(0);
    expect(advanced).toEqual(["step-export"]);
  });

  it("④ 重复调用 ⇒ duplicate，不再写回/推进", async () => {
    await store.recordAnswer(record());
    const { ports, writes, advanced } = makePorts({});
    await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:04:00.000Z" },
    );
    const second = await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:05:00.000Z" },
    );
    expect(second.kind).toBe("duplicate");
    expect(writes).toHaveLength(1);
    expect(advanced).toEqual(["step-export"]);
  });

  it("⑤ 已取消的 mission ⇒ 不推进（迟到答案不重启任务）", async () => {
    await store.recordAnswer(record());
    const { ports, writes, advanced } = makePorts({ missionStatus: "cancelled" });
    const outcome = await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:06:00.000Z" },
    );
    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind !== "cancelled") return;
    expect(outcome.record.status).toBe("cancelled");
    expect(writes).toHaveLength(0);
    expect(advanced).toHaveLength(0);
  });

  it("⑥ 文档 revision 回退 ⇒ 冲突：保留决定、不写回不推进", async () => {
    await store.recordAnswer(record({ documentRevision: 5 }));
    const { ports, writes, advanced } = makePorts({ documentRevision: 3 });
    const outcome = await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:07:00.000Z" },
    );
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.record.status).toBe("conflict");
    expect(writes).toHaveLength(0);
    expect(advanced).toHaveLength(0);
    expect((await store.list())[0]?.decisionIdentifier).toBe("decision-1");
  });

  it("⑦ 只推进显式依赖该决定的步骤（affected 之外的等待步骤不动）", async () => {
    await store.recordAnswer(record({ affectedStepIdentifiers: ["step-export"] }));
    const { ports, advanced } = makePorts({
      steps: [
        {
          stepIdentifier: "step-export",
          status: "waiting-on-decision",
          dependsOnDecisionIdentifiers: ["decision-1"],
        },
        {
          stepIdentifier: "step-other-waiting",
          status: "waiting-on-decision",
          dependsOnDecisionIdentifiers: [],
        },
      ],
    });
    const outcome = await applyDecisionWriteback(
      { store, ports },
      { decisionIdentifier: "decision-1", nowIso: "2026-11-22T00:08:00.000Z" },
    );
    expect(outcome.kind).toBe("advanced");
    expect(advanced).toEqual(["step-export"]);
  });
});
