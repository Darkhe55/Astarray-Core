/**
 * COORD-01-03（卡 §3）：回复产物引用**与实际版本核对**。
 *
 * 反例优先：
 * - 门禁要求产物证明但**未提供引用** ⇒ 不通过（`artifact-not-provided`）；
 * - 引用版本**低于**当前 ⇒ stale，不通过；
 * - 引用版本**高于**当前 ⇒ future（引用尚未产生的版本），不通过；
 * - 产物解析不到 ⇒ missing，不通过；
 * - 普通消息（不要求产物证明）可合法无引用 ⇒ 通过。
 */
import { describe, expect, it } from "vitest";

import { verifyReplyArtifactReferences } from "../../../packages/core/src/orchestration/reply-artifact-verification.js";

const currentRevisions: Record<string, number> = {
  "src/a.ts": 3,
  "src/b.ts": 1,
};

const resolveCurrentRevision = async (artifactIdentifier: string): Promise<number | null> =>
  currentRevisions[artifactIdentifier] ?? null;

describe("回复产物引用核对", () => {
  it("① 要求产物证明但未提供引用 ⇒ 不通过", async () => {
    const result = await verifyReplyArtifactReferences({
      references: [],
      resolveCurrentRevision,
      isArtifactProofRequired: true,
    });
    expect(result.isSatisfied).toBe(false);
    expect(result.unsatisfiedReason).toBe("artifact-not-provided");
  });

  it("② 引用版本低于当前 ⇒ stale，不通过", async () => {
    const result = await verifyReplyArtifactReferences({
      references: [{ artifactIdentifier: "src/a.ts", revision: 2 }],
      resolveCurrentRevision,
      isArtifactProofRequired: true,
    });
    expect(result.isSatisfied).toBe(false);
    expect(result.unsatisfiedReason).toContain("stale");
    expect(result.verdicts[0]).toMatchObject({ state: "stale", currentRevision: 3 });
  });

  it("③ 引用版本高于当前 ⇒ future，不通过（不得按“更新”放行）", async () => {
    const result = await verifyReplyArtifactReferences({
      references: [{ artifactIdentifier: "src/a.ts", revision: 9 }],
      resolveCurrentRevision,
      isArtifactProofRequired: true,
    });
    expect(result.isSatisfied).toBe(false);
    expect(result.verdicts[0]?.state).toBe("future");
  });

  it("④ 产物解析不到 ⇒ missing，不通过", async () => {
    const result = await verifyReplyArtifactReferences({
      references: [{ artifactIdentifier: "src/ghost.ts", revision: 1 }],
      resolveCurrentRevision,
      isArtifactProofRequired: true,
    });
    expect(result.isSatisfied).toBe(false);
    expect(result.verdicts[0]?.state).toBe("missing");
  });

  it("⑤ 版本一致 ⇒ 通过；普通消息无引用 ⇒ 也通过", async () => {
    const matching = await verifyReplyArtifactReferences({
      references: [{ artifactIdentifier: "src/a.ts", revision: 3 }],
      resolveCurrentRevision,
      isArtifactProofRequired: true,
    });
    expect(matching.isSatisfied).toBe(true);

    const informational = await verifyReplyArtifactReferences({
      references: [],
      resolveCurrentRevision,
      isArtifactProofRequired: false,
    });
    expect(informational.isSatisfied).toBe(true);
  });
});
