/**
 * WIRING-04-04 补口（2026-11-25）：固定旧版本读取的反例。
 *
 * 卡内固定语义：固定版本缺失/哈希不符 ⇒ 必要输入 blocked；
 * 最新版前进只产生 revision-advanced 提示，**不自动换版本、也不因此拒绝有效旧版本**。
 */
import { describe, expect, it } from "vitest";

import type { ContextPack } from "../../../packages/core/src/orchestration/context-pack.js";
import {
  computeContextPackContentHash,
  resolveContextPackForMissionTask,
  type ContextPackResolutionPort,
} from "../../../packages/core/src/orchestration/context-pack-resolution.js";

function pack(summary: string): ContextPack {
  return {
    packIdentifier: "pack-1",
    mergePolicy: "append",
    sourcePriority: ["user"],
    members: [
      {
        memberIdentifier: "m-1",
        sourceKind: "document",
        summary,
        contentFingerprint: "sha256:member",
      },
    ],
  } as unknown as ContextPack;
}

const CURRENT = pack("当前版本正文");

function buildPort(options: {
  readonly latestRevision: number;
  readonly latestPack?: ContextPack;
  readonly revisionPacks?: Readonly<Record<number, ContextPack>>;
  readonly omitRevisionReader?: boolean;
}): ContextPackResolutionPort {
  return {
    async findExactBinding() {
      return { sequenceTaskIdentifier: "seq-task-1" };
    },
    async readSequenceTask() {
      return {
        contextPack: options.latestPack ?? CURRENT,
        revision: options.latestRevision,
      };
    },
    ...(options.omitRevisionReader === true
      ? {}
      : {
          async readSequenceTaskAtRevision(input: { readonly revision: number }) {
            const found = options.revisionPacks?.[input.revision];
            return found === undefined
              ? null
              : { contextPack: found, revision: input.revision };
          },
        }),
  };
}

function call(port: ContextPackResolutionPort, extra: Record<string, unknown> = {}) {
  return resolveContextPackForMissionTask({
    missionIdentifier: "mission-1",
    missionTaskIdentifier: "T-1",
    sequenceIdentifier: "seq-1",
    sequenceOwnerAgentInstanceIdentifier: "agent-1",
    port,
    ...extra,
  });
}

describe("WIRING-04-04 固定旧版本读取", () => {
  it("① 旧版本可读 ⇒ 用旧版本正文，并提示最新版已前进（不自动换版本）", async () => {
    const oldPack = pack("旧版本正文");
    const result = await call(
      buildPort({ latestRevision: 5, revisionPacks: { 3: oldPack } }),
      { pinnedRevision: 3 },
    );
    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.revision).toBe(3);
    expect(result.pack.members[0]?.summary).toBe("旧版本正文");
    expect(result.contentHash).toBe(computeContextPackContentHash(oldPack));
    expect(result.revisionAdvancedNotice).toContain("revision=5");
    expect(result.revisionAdvancedNotice).toContain("不自动换版本");
  });

  it("② 固定版本缺失 ⇒ declared-but-missing（必要输入 blocked）", async () => {
    const result = await call(buildPort({ latestRevision: 5 }), { pinnedRevision: 4 });
    expect(result).toMatchObject({ kind: "declared-but-missing" });
    if (result.kind !== "declared-but-missing") return;
    expect(result.reason).toContain("固定版本");
  });

  it("③ 内容哈希不符 ⇒ declared-but-missing（不按正文猜测）", async () => {
    const result = await call(
      buildPort({ latestRevision: 5, revisionPacks: { 3: pack("旧") } }),
      { pinnedRevision: 3, expectedContentHash: "sha256:wrong" },
    );
    expect(result).toMatchObject({ kind: "declared-but-missing" });
    if (result.kind !== "declared-but-missing") return;
    expect(result.reason).toContain("哈希不符");
  });

  it("④ pinnedRevision=0 ⇒ 拒绝（禁止用 0 占位）", async () => {
    const result = await call(buildPort({ latestRevision: 2 }), { pinnedRevision: 0 });
    expect(result).toMatchObject({ kind: "declared-but-missing" });
    if (result.kind !== "declared-but-missing") return;
    expect(result.reason).toContain("正整数");
  });

  it("⑤ 端口不提供历史读取 ⇒ 请求旧版本即 blocked（不自动换最新）", async () => {
    const result = await call(buildPort({ latestRevision: 5, omitRevisionReader: true }), {
      pinnedRevision: 3,
    });
    expect(result).toMatchObject({ kind: "declared-but-missing" });
  });

  it("⑥ 未固定版本 ⇒ 沿用最新 revision 且无前进提示（行为不变）", async () => {
    const result = await call(buildPort({ latestRevision: 5 }));
    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.revision).toBe(5);
    expect(result.revisionAdvancedNotice ?? null).toBeNull();
  });

  it("⑦ 固定版本等于最新版 ⇒ 无前进提示", async () => {
    const result = await call(
      buildPort({ latestRevision: 3, revisionPacks: { 3: CURRENT } }),
      { pinnedRevision: 3 },
    );
    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.revisionAdvancedNotice ?? null).toBeNull();
  });
});
