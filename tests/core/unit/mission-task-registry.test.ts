/**
 * MISSION-WRITE-01 切片 1（2026-11-28）：幂等判定纯函数 + 任务注册表容器（反例优先）。
 *
 * 语义必须与门面原实现逐字一致：
 * - 同键异参 ⇒ conflict（调用方抛 idempotency-key-conflict）；
 * - 同键同参未结算 ⇒ claim-pending（不重复执行、不假定成功）；
 * - 同键同参已结算 ⇒ reuse-settled（有记录投影记录，否则 accepted 骨架）；
 * - 未命中 ⇒ claim。
 */
import { describe, expect, it } from "vitest";

import {
  MissionTaskRegistry,
  computeTaskSubmissionInputHash,
  evaluateExistingTaskForSubmission,
  evaluateIdempotentSubmission,
  resolveIdempotencyLedgerKey,
  type MissionTaskIdempotencyEntry,
} from "../../../packages/core/src/orchestration/mission-task-registry.js";

const settledEntry: MissionTaskIdempotencyEntry = {
  sessionIdentifier: "session-1",
  idempotencyKey: "key-1",
  inputHash: "hash-a",
  taskIdentifier: "task-1",
  missionIdentifier: "mission-1",
  claimedAtIso: "2026-11-28T10:00:00.000Z",
  settledAtIso: "2026-11-28T10:00:01.000Z",
};

function evaluate(overrides: {
  entry?: MissionTaskIdempotencyEntry;
  inputHash?: string;
  hasRecord?: boolean;
  idempotencyKey?: string | undefined;
}) {
  const entries = new Map<string, MissionTaskIdempotencyEntry>();
  if (overrides.entry !== undefined) {
    entries.set(
      resolveIdempotencyLedgerKey(overrides.entry.sessionIdentifier, overrides.entry.idempotencyKey),
      overrides.entry,
    );
  }
  return evaluateIdempotentSubmission({
    sessionId: overrides.entry?.sessionIdentifier ?? "session-1",
    ...(overrides.idempotencyKey === undefined && overrides.entry !== undefined
      ? { idempotencyKey: overrides.entry.idempotencyKey }
      : overrides.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: overrides.idempotencyKey }),
    inputHash: overrides.inputHash ?? "hash-a",
    findEntry: (key) => entries.get(key),
    hasTaskRecord: () => overrides.hasRecord === true,
  });
}

describe("MISSION-WRITE-01：幂等判定", () => {
  it("① 无幂等键 ⇒ no-idempotency-key（不登记任何 claim）", () => {
    expect(evaluate({ idempotencyKey: undefined })).toEqual({ kind: "no-idempotency-key" });
  });

  it("② 同键异参 ⇒ conflict（附原条目）", () => {
    const outcome = evaluate({ entry: settledEntry, inputHash: "hash-b" });
    expect(outcome.kind).toBe("conflict");
  });

  it("③ 同键同参未结算 ⇒ claim-pending（不假定成功）", () => {
    const outcome = evaluate({
      entry: { ...settledEntry, missionIdentifier: null, settledAtIso: null },
    });
    expect(outcome.kind).toBe("claim-pending");
  });

  it("④ 同键同参已结算：有记录 ⇒ reuse-settled(hasTaskRecord=true)",
    () => {
      const outcome = evaluate({ entry: settledEntry, hasRecord: true });
      expect(outcome).toMatchObject({ kind: "reuse-settled", hasTaskRecord: true });
    },
  );

  it("⑤ 同键同参已结算但记录已丢 ⇒ reuse-settled(hasTaskRecord=false)（回 accepted 骨架）", () => {
    const outcome = evaluate({ entry: settledEntry, hasRecord: false });
    expect(outcome).toMatchObject({ kind: "reuse-settled", hasTaskRecord: false });
  });

  it("⑥ 未命中 ⇒ claim，键为「会话|幂等键」", () => {
    const outcome = evaluate({ idempotencyKey: "key-new" });
    expect(outcome).toEqual({ kind: "claim", ledgerKey: "session-1|key-new" });
  });

  it("⑦ 跨会话隔离：不同会话的同名幂等键互不复用", () => {
    const entries = new Map([
      [resolveIdempotencyLedgerKey("session-1", "key-1"), settledEntry],
    ]);
    const outcome = evaluateIdempotentSubmission({
      sessionId: "session-2",
      idempotencyKey: "key-1",
      inputHash: "hash-a",
      findEntry: (key) => entries.get(key),
      hasTaskRecord: () => true,
    });
    expect(outcome.kind).toBe("claim");
  });
});

describe("MISSION-WRITE-01：任务注册表容器", () => {
  it("⑧ 记录 upsert/find/list/delete 与幂等账目 round-trip", () => {
    const registry = new MissionTaskRegistry<{ status: string }>();
    registry.upsertTaskRecord("task-1", { status: "queued" });
    expect(registry.findTaskRecord("task-1")).toEqual({ status: "queued" });
    expect(registry.listTaskRecords()).toEqual([["task-1", { status: "queued" }]]);

    registry.recordIdempotencyEntry(settledEntry);
    expect(registry.findIdempotencyEntry("session-1", "key-1")).toEqual(settledEntry);
    expect(registry.listIdempotencyEntries()).toHaveLength(1);

    expect(registry.deleteTaskRecord("task-1")).toBe(true);
    expect(registry.findTaskRecord("task-1")).toBeUndefined();
  });

  it("⑨ 构造时从既有账目恢复（含跨会话同键互不覆盖）", () => {
    const registry = new MissionTaskRegistry<unknown>({
      idempotencyEntries: [
        settledEntry,
        {
          ...settledEntry,
          sessionIdentifier: "session-2",
          taskIdentifier: "task-2",
          missionIdentifier: "mission-2",
        },
      ],
    });
    expect(registry.findIdempotencyEntry("session-1", "key-1")?.taskIdentifier).toBe("task-1");
    expect(registry.findIdempotencyEntry("session-2", "key-1")?.taskIdentifier).toBe("task-2");
  });
});

describe("MISSION-WRITE-01：任务内容哈希", () => {
  it("⑩ 同内容同哈希；不同归属参数不同哈希；分隔符避免拼接碰撞", () => {
    const base = computeTaskSubmissionInputHash({ prompt: "do it" });
    expect(computeTaskSubmissionInputHash({ prompt: "do it" })).toBe(base);
    expect(
      computeTaskSubmissionInputHash({ prompt: "do it", projectIdentifier: "project-a" }),
    ).not.toBe(base);
    expect(
      computeTaskSubmissionInputHash({ prompt: "do it", workspaceRootPath: "C:/a" }),
    ).not.toBe(base);

    const left = computeTaskSubmissionInputHash({
      prompt: "a",
      projectIdentifier: "b",
    });
    const right = computeTaskSubmissionInputHash({
      prompt: "ab",
      projectIdentifier: "",
    });
    expect(left).not.toBe(right);
  });
});

describe("MISSION-WRITE-01：既有任务提交判定（切片 2）", () => {
  it("⑪ 无既有任务 ⇒ absent", () => {
    expect(evaluateExistingTaskForSubmission({ requestedSessionId: "s1" })).toEqual({
      kind: "absent",
    });
  });

  it("⑫ 同会话 ⇒ reuse（投影不重建）", () => {
    expect(
      evaluateExistingTaskForSubmission({
        requestedSessionId: "s1",
        existingTaskSessionId: "s1",
      }),
    ).toEqual({ kind: "reuse" });
  });

  it("⑬ 跨会话 ⇒ session-mismatch（调用方抛既有文案）", () => {
    expect(
      evaluateExistingTaskForSubmission({
        requestedSessionId: "s1",
        existingTaskSessionId: "s2",
      }),
    ).toEqual({ kind: "session-mismatch" });
  });
});
