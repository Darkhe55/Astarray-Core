/**
 * WIRING-04-04（2026-11-22）：任务包解析反例。
 *
 * 卡内要求区分：no-pack-declared（合法） / pack（固定 revision + 内容哈希） /
 * mapping-missing 与 declared-but-missing（阻塞，不按名称/最近任务/固定 T-001 猜）。
 * 另钉住"声明来源的严格度"与"只在完全缺失时自愈补映射"。
 */
import { describe, expect, it } from "vitest";

import {
  classifyContextPackMapping,
  computeContextPackContentHash,
  resolveContextPackForMissionTask,
  shouldBackfillDeclaredMapping,
  type ContextPackResolutionPort,
} from "../../../packages/core/src/orchestration/context-pack-resolution.js";
import type { ContextPack } from "../../../packages/core/src/orchestration/context-pack.js";

const declared = {
  sequenceTaskIdentifier: "seq-task-1",
  sequenceIdentifier: "sequence-1",
  ownerAgentInstanceIdentifier: "agent-1",
};

const entry = {
  missionTaskIdentifier: "T-1",
  sequenceTaskIdentifier: "seq-task-1",
  sequenceIdentifier: "sequence-1",
  ownerAgentInstanceIdentifier: "agent-1",
};

const pack = {
  packIdentifier: "pack-1",
  mergePolicy: "union",
  sourcePriority: [],
  members: [
    {
      memberIdentifier: "member-1",
      sourceKind: "document",
      summary: "规范摘要",
    },
  ],
} as unknown as ContextPack;

describe("WIRING-04-04：任务包映射分类", () => {
  it("① 完整声明 + 精确映射 ⇒ exact", () => {
    const outcome = classifyContextPackMapping({
      missionTaskIdentifier: "T-1",
      entries: [entry],
      declaredSource: declared,
    });
    expect(outcome.kind).toBe("exact");
  });

  it("② 完整声明但缺映射 ⇒ declared-missing（阻塞）", () => {
    const outcome = classifyContextPackMapping({
      missionTaskIdentifier: "T-1",
      entries: [],
      declaredSource: declared,
    });
    expect(outcome.kind).toBe("declared-missing");
  });

  it("③ 完整声明与映射不一致 ⇒ declared-missing（不按映射猜）", () => {
    const outcome = classifyContextPackMapping({
      missionTaskIdentifier: "T-1",
      entries: [{ ...entry, sequenceTaskIdentifier: "other-task" }],
      declaredSource: declared,
    });
    expect(outcome.kind).toBe("declared-missing");
  });

  it("④ 未声明来源但存在精确项 ⇒ exact；只有整 mission 通配 ⇒ imprecise；都没有 ⇒ missing", () => {
    expect(
      classifyContextPackMapping({
        missionTaskIdentifier: "T-1",
        entries: [entry],
        declaredSource: null,
      }).kind,
    ).toBe("exact");
    expect(
      classifyContextPackMapping({
        missionTaskIdentifier: "T-1",
        entries: [{ ...entry, missionTaskIdentifier: "*" }],
        declaredSource: null,
      }).kind,
    ).toBe("imprecise");
    expect(
      classifyContextPackMapping({
        missionTaskIdentifier: "T-1",
        entries: [],
        declaredSource: null,
      }).kind,
    ).toBe("missing");
  });
});

describe("WIRING-04-04：自愈补映射的边界", () => {
  it("⑤ 只在完整声明且完全没有映射项时补", () => {
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-1",
        declaredSource: declared,
        entries: [],
      }),
    ).toBe(true);
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-1",
        declaredSource: declared,
        entries: [{ missionTaskIdentifier: "T-1" }],
      }),
    ).toBe(false);
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-1",
        declaredSource: { sequenceTaskIdentifier: "seq-task-1" },
        entries: [],
      }),
    ).toBe(false);
    expect(
      shouldBackfillDeclaredMapping({
        missionTaskIdentifier: "T-1",
        declaredSource: null,
        entries: [],
      }),
    ).toBe(false);
  });
});

describe("WIRING-04-04：任务包解析", () => {
  function makePort(options: {
    binding: { sequenceTaskIdentifier: string } | null;
    sequenceTask: { contextPack: ContextPack | null; revision: number } | null;
  }): ContextPackResolutionPort {
    return {
      findExactBinding: async () => options.binding,
      readSequenceTask: async () => options.sequenceTask,
    };
  }

  const base = {
    missionIdentifier: "m-1",
    missionTaskIdentifier: "T-1",
    sequenceIdentifier: "sequence-1",
    sequenceOwnerAgentInstanceIdentifier: "agent-1",
  };

  it("⑥ 缺精确映射 ⇒ mapping-missing；映射指向读不到的节点 ⇒ declared-but-missing", async () => {
    expect(
      await resolveContextPackForMissionTask({
        ...base,
        port: makePort({ binding: null, sequenceTask: null }),
      }),
    ).toMatchObject({ kind: "mapping-missing" });

    expect(
      await resolveContextPackForMissionTask({
        ...base,
        port: makePort({ binding: { sequenceTaskIdentifier: "seq-task-1" }, sequenceTask: null }),
      }),
    ).toMatchObject({ kind: "declared-but-missing" });
  });

  it("⑦ 节点没有包 ⇒ no-pack-declared（合法，不当作缺失）", async () => {
    const outcome = await resolveContextPackForMissionTask({
      ...base,
      port: makePort({
        binding: { sequenceTaskIdentifier: "seq-task-1" },
        sequenceTask: { contextPack: null, revision: 3 },
      }),
    });
    expect(outcome).toEqual({ kind: "no-pack-declared" });
  });

  it("⑧ revision 为 0 占位 ⇒ declared-but-missing（不得固定假版本）", async () => {
    const outcome = await resolveContextPackForMissionTask({
      ...base,
      port: makePort({
        binding: { sequenceTaskIdentifier: "seq-task-1" },
        sequenceTask: { contextPack: pack, revision: 0 },
      }),
    });
    expect(outcome).toMatchObject({ kind: "declared-but-missing" });
  });

  it("⑨ 正常包 ⇒ pack + 固定 revision + 内容哈希（同内容稳定）", async () => {
    const outcome = await resolveContextPackForMissionTask({
      ...base,
      port: makePort({
        binding: { sequenceTaskIdentifier: "seq-task-1" },
        sequenceTask: { contextPack: pack, revision: 3 },
      }),
    });
    expect(outcome.kind).toBe("pack");
    if (outcome.kind !== "pack") return;
    expect(outcome.revision).toBe(3);
    expect(outcome.contentHash).toBe(computeContextPackContentHash(pack));
    expect(outcome.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
