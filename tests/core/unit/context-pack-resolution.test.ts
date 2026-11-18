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

describe("WIRING-04-04：按是否声明来源决定严格度", () => {
  const entry = {
    missionTaskIdentifier: "T-003",
    sequenceTaskIdentifier: "seq-task-7",
    sequenceIdentifier: "sequence-1",
    ownerAgentInstanceIdentifier: "agent-1",
  };

  it("⑦ 声明来源且映射一致 ⇒ exact", async () => {
    const { classifyContextPackMapping } = await import(
      "../../../packages/core/src/orchestration/context-pack-resolution.js"
    );
    const result = classifyContextPackMapping({
      missionTaskIdentifier: "T-003",
      entries: [entry],
      declaredSource: {
        sequenceTaskIdentifier: "seq-task-7",
        sequenceIdentifier: "sequence-1",
        ownerAgentInstanceIdentifier: "agent-1",
      },
    });
    expect(result.kind).toBe("exact");
  }, 30_000);

  it("⑧ 声明了来源但映射缺失/不符 ⇒ declared-missing（阻塞）", async () => {
    const { classifyContextPackMapping } = await import(
      "../../../packages/core/src/orchestration/context-pack-resolution.js"
    );
    const missing = classifyContextPackMapping({
      missionTaskIdentifier: "T-003",
      entries: [],
      declaredSource: {
        sequenceTaskIdentifier: "seq-task-7",
        sequenceIdentifier: "sequence-1",
        ownerAgentInstanceIdentifier: "agent-1",
      },
    });
    expect(missing.kind).toBe("declared-missing");

    const mismatched = classifyContextPackMapping({
      missionTaskIdentifier: "T-003",
      entries: [entry],
      declaredSource: {
        sequenceTaskIdentifier: "seq-task-8",
        sequenceIdentifier: "sequence-1",
        ownerAgentInstanceIdentifier: "agent-1",
      },
    });
    expect(mismatched.kind).toBe("declared-missing");
  }, 30_000);

  it("⑨ 未声明来源 ⇒ 过渡态（通配为 imprecise、无关联为 missing）", async () => {
    const { classifyContextPackMapping } = await import(
      "../../../packages/core/src/orchestration/context-pack-resolution.js"
    );
    const imprecise = classifyContextPackMapping({
      missionTaskIdentifier: "T-009",
      entries: [{ ...entry, missionTaskIdentifier: "*" }],
      declaredSource: null,
    });
    expect(imprecise.kind).toBe("imprecise");

    const missing = classifyContextPackMapping({
      missionTaskIdentifier: "T-009",
      entries: [],
      declaredSource: null,
    });
    expect(missing.kind).toBe("missing");
  }, 30_000);
});

describe("WIRING-04-04：缺失精确映射的自愈判定", () => {
  const declared = {
    sequenceTaskIdentifier: "seq-task-7",
    sequenceIdentifier: "sequence-1",
    ownerAgentInstanceIdentifier: "agent-1",
  };

  it("⑩ 完整声明 + 无任何映射项 ⇒ 可以补写（创建时绑定失败的恢复路径）", async () => {
    const { shouldBackfillDeclaredMapping } = await import(
      "../../../packages/core/src/orchestration/context-pack-resolution.js"
    );
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-003",
        declaredSource: declared,
        entries: [],
      }),
    ).toBe(true);
  }, 30_000);

  it("⑪ 已存在该任务映射项（即便不一致）⇒ **不补**，交给阻塞分支", async () => {
    const { shouldBackfillDeclaredMapping } = await import(
      "../../../packages/core/src/orchestration/context-pack-resolution.js"
    );
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-003",
        declaredSource: declared,
        entries: [{ missionTaskIdentifier: "T-003" }],
      }),
    ).toBe(false);
  }, 30_000);

  it("⑫ 未声明来源或声明不完整 ⇒ 不补（不猜）", async () => {
    const { shouldBackfillDeclaredMapping } = await import(
      "../../../packages/core/src/orchestration/context-pack-resolution.js"
    );
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-003",
        declaredSource: null,
        entries: [],
      }),
    ).toBe(false);
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-003",
        declaredSource: { sequenceTaskIdentifier: "seq-task-7" },
        entries: [],
      }),
    ).toBe(false);
  }, 30_000);
});
