/**
 * WIRING-04 §36.3 反例：独立完成裁决的**不可变首次创建**（2026-11-19）。
 *
 * 裁决是验收结论：同一 mission/task 只允许一份。两个实例并发写不同裁决时，
 * 必须恰好一个成功、另一个被明确拒绝，磁盘保留胜出者（不允许静默改写结论）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionVerdictStore } from "../../../packages/core/src/orchestration/completion-verdict-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-immutable-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): CompletionVerdictStore {
  return new CompletionVerdictStore({ baseDirectory: stateDirectory });
}

describe("WIRING-04 §36.3：完成裁决的不可变首次创建", () => {
  it("① 并发写入不同裁决 ⇒ 只有一个落盘，另一个被拒 journal-corrupted", async () => {
    const results = await Promise.allSettled([
      buildStore().save({
        missionIdentifier: "mission-1",
        taskIdentifier: "T-001",
        verdict: "accepted",
        reasons: [],
        deciderAgentInstanceIdentifier: "reviewer-1",
        decidedAtIso: "2026-11-18T00:00:00.000Z",
      }),
      buildStore().save({
        missionIdentifier: "mission-1",
        taskIdentifier: "T-001",
        verdict: "rejected",
        reasons: ["证据不足"],
        deciderAgentInstanceIdentifier: "reviewer-2",
        decidedAtIso: "2026-11-18T00:00:01.000Z",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect((rejection?.reason as { errorCode?: string }).errorCode).toBe("journal-corrupted");

    const stored = await buildStore().read("mission-1", "T-001");
    expect(["accepted", "rejected"]).toContain(stored?.verdict);
  }, 60_000);

  it("② 同内容重复写入 ⇒ 幂等（didWrite=false）", async () => {
    const record = {
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
      verdict: "accepted" as const,
      reasons: [],
      deciderAgentInstanceIdentifier: "reviewer-1",
      decidedAtIso: "2026-11-18T00:00:00.000Z",
    };
    const first = await buildStore().save(record);
    const second = await buildStore().save(record);
    expect(first.didWrite).toBe(true);
    expect(second.didWrite).toBe(false);
  }, 60_000);
});
