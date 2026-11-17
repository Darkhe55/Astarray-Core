import { describe, expect, it } from "vitest";

import {
  rankOptionalContextCandidates,
  type OptionalContextCandidate,
} from "../../../packages/core/src/orchestration/context-optional-scorer.js";

type ScoredCandidate = OptionalContextCandidate & { readonly score: number };

function candidate(identifier: string, score: number): ScoredCandidate {
  return {
    record: {
      globalDecisionIdentifier: identifier,
      decisionSummary: identifier,
    } as never,
    category: "interface-or-artifact-contract",
    estimatedTokenCount: 10,
    phase: "execution",
    score,
  };
}

describe("P6 optional context scorer", () => {
  it("keeps stable order when no scorer is provided", () => {
    const candidates = [candidate("b", 1), candidate("a", 2)];
    expect(
      rankOptionalContextCandidates(candidates, undefined).map(
        (entry) => entry.record.globalDecisionIdentifier,
      ),
    ).toEqual(["b", "a"]);
  });

  it("ranks optional candidates by the injected score and falls back to identifier", () => {
    const candidates = [candidate("a", 1), candidate("b", 3), candidate("c", 2)];
    const ranked = rankOptionalContextCandidates(
      candidates,
      (entry) => (entry as ScoredCandidate).score,
    );
    expect(ranked.map((entry) => entry.record.globalDecisionIdentifier)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});
