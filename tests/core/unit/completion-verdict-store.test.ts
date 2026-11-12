/**
 * 完成裁决存储（此前 `tests/` 零引用）：**裁决是证据，不可被事后改写**。
 *
 * 反例优先：缺标识 / 匿名裁决者 / 非法时间 / 无理由 rejected ⇒ 一律拒绝；
 * 同内容 ⇒ 幂等；同 mission+task **不同内容 ⇒ 拒绝覆盖**；损坏文件读回 null（不伪造裁决）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompletionVerdictStore } from "../../../packages/core/src/orchestration/completion-verdict-store.js";
import type { CompletionVerdictRecord } from "../../../packages/core/src/orchestration/completion-verdict-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-store-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildRecord(overrides: Partial<CompletionVerdictRecord> = {}): CompletionVerdictRecord {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    verdict: "accepted",
    reasons: ["证据齐全"],
    deciderAgentInstanceIdentifier: "tertiary-accept",
    decidedAtIso: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("完成裁决存储", () => {
  it("① 缺 mission 或 task 标识 ⇒ 拒绝", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    await expect(store.save(buildRecord({ missionIdentifier: "  " }))).rejects.toThrow(/mission 与 task/u);
    await expect(store.save(buildRecord({ taskIdentifier: "" }))).rejects.toThrow(/mission 与 task/u);
  });

  it("② 裁决者为空 ⇒ 拒绝（不接受匿名/角色名）", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    await expect(
      store.save(buildRecord({ deciderAgentInstanceIdentifier: "   " })),
    ).rejects.toThrow(/裁决者个体标识/u);
  });

  it("③ 时间非法 ⇒ 拒绝", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    await expect(store.save(buildRecord({ decidedAtIso: "not-a-date" }))).rejects.toThrow(/时间非法/u);
  });

  it("④ rejected 必须给理由；accepted 可空理由", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    await expect(
      store.save(buildRecord({ verdict: "rejected", reasons: [] })),
    ).rejects.toThrow(/必须给出理由/u);
    const accepted = await store.save(
      buildRecord({ taskIdentifier: "T-002", verdict: "accepted", reasons: [] }),
    );
    expect(accepted.didWrite).toBe(true);
  });

  it("⑤ 首次写入可读回；⑥ 同内容重复写入幂等（didWrite=false）", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    expect((await store.save(buildRecord())).didWrite).toBe(true);
    const stored = await store.read("mission-1", "T-001");
    expect(stored).toEqual(buildRecord());
    expect((await store.save(buildRecord())).didWrite).toBe(false);
  });

  it("⑦ 同 mission/task 不同内容 ⇒ 拒绝覆盖（裁决不可改写）", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    await store.save(buildRecord());
    await expect(
      store.save(buildRecord({ verdict: "rejected", reasons: ["事后反悔"] })),
    ).rejects.toThrow(/拒绝覆盖/u);
    /** 原裁决保持不变。 */
    expect((await store.read("mission-1", "T-001"))?.verdict).toBe("accepted");
  });

  it("⑧ listForMission 按 task 排序；损坏文件读回 null 且不掺入列表", async () => {
    const store = new CompletionVerdictStore({ baseDirectory });
    await store.save(buildRecord({ taskIdentifier: "T-002" }));
    await store.save(buildRecord({ taskIdentifier: "T-001" }));
    expect((await store.listForMission("mission-1")).map((record) => record.taskIdentifier)).toEqual([
      "T-001",
      "T-002",
    ]);

    const missionDirectory = path.join(baseDirectory, "completion-verdicts", "mission-1");
    await fs.writeFile(path.join(missionDirectory, "T-003.json"), '{"schemaVersion":2}', "utf8");
    expect(await store.read("mission-1", "T-003")).toBeNull();
    expect((await store.listForMission("mission-1")).map((record) => record.taskIdentifier)).toEqual([
      "T-001",
      "T-002",
    ]);
    expect(await store.listForMission("mission-unknown")).toEqual([]);
  });
});
