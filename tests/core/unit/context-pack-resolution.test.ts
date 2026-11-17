/**
 * WIRING-04-04（方案 C）反例：当前任务包必须经**精确映射**解析。
 *
 * 覆盖卡内要求：缺映射阻塞、声明有包却读不到阻塞、未声明包可无包运行、
 * 固定 revision（禁止 0 占位）、内容哈希稳定。
 */
import { describe, expect, it } from "vitest";

import {
  computeContextPackContentHash,
  resolveContextPackForMissionTask,
  type ContextPackResolutionPort,
} from "../../../packages/core/src/orchestration/context-pack-resolution.js";
import type { ContextPack } from "../../../packages/core/src/orchestration/context-pack.js";

const pack: ContextPack = {
  packIdentifier: "pack-1",
  mergePolicy: "summarize-allowed",
  sourcePriority: "agent",
  members: [
    { memberIdentifier: "m-1", sourceKind: "agent", summary: "事实一" },
  ],
};

function buildPort(overrides: Partial<ContextPackResolutionPort> = {}): ContextPackResolutionPort {
  return {
    findExactBinding: async () => ({ sequenceTaskIdentifier: "S-1" }),
    readSequenceTask: async () => ({ contextPack: pack, revision: 7 }),
    ...overrides,
  };
}

const baseInput = {
  missionIdentifier: "mission-1",
  missionTaskIdentifier: "T-1",
  sequenceIdentifier: "sequence-1",
  sequenceOwnerAgentInstanceIdentifier: "agent-1",
};

describe("WIRING-04-04：任务包解析", () => {
  it("① 精确映射命中 ⇒ 返回包 + 固定 revision + 内容哈希", async () => {
    const resolution = await resolveContextPackForMissionTask({
      ...baseInput,
      port: buildPort(),
    });
    expect(resolution).toMatchObject({ kind: "pack", revision: 7 });
    if (resolution.kind === "pack") {
      expect(resolution.contentHash).toBe(computeContextPackContentHash(pack));
      expect(resolution.contentHash).toHaveLength(64);
    }
  });

  it("② 缺映射 ⇒ mapping-missing（不按名称或最近任务猜）", async () => {
    const resolution = await resolveContextPackForMissionTask({
      ...baseInput,
      port: buildPort({ findExactBinding: async () => null }),
    });
    expect(resolution.kind).toBe("mapping-missing");
  });

  it("③ 映射指向的序列任务读不到 ⇒ declared-but-missing（不当作无包）", async () => {
    const resolution = await resolveContextPackForMissionTask({
      ...baseInput,
      port: buildPort({ readSequenceTask: async () => null }),
    });
    expect(resolution.kind).toBe("declared-but-missing");
  });

  it("④ 确实未声明包 ⇒ no-pack-declared（可无包运行）", async () => {
    const resolution = await resolveContextPackForMissionTask({
      ...baseInput,
      port: buildPort({ readSequenceTask: async () => ({ contextPack: null, revision: 3 }) }),
    });
    expect(resolution.kind).toBe("no-pack-declared");
  });

  it("⑤ 声明了包但 revision 为 0 ⇒ 阻塞（禁止 0 占位）", async () => {
    const resolution = await resolveContextPackForMissionTask({
      ...baseInput,
      port: buildPort({ readSequenceTask: async () => ({ contextPack: pack, revision: 0 }) }),
    });
    expect(resolution.kind).toBe("declared-but-missing");
    if (resolution.kind === "declared-but-missing") {
      expect(resolution.reason).toContain("0");
    }
  });

  it("⑥ 同内容哈希稳定、改内容后变化", async () => {
    const sameHash = computeContextPackContentHash({ ...pack });
    expect(sameHash).toBe(computeContextPackContentHash(pack));
    const changedHash = computeContextPackContentHash({
      ...pack,
      members: [{ memberIdentifier: "m-1", sourceKind: "agent", summary: "事实二" }],
    });
    expect(changedHash).not.toBe(sameHash);
  });
});
