/**
 * 凭据检测覆盖夹具（此前 `tests/` 零引用）——**夹具本身也要被验证**。
 *
 * 这里做的是元检验：
 * - 每条**正例**必须真被至少一条检测规则命中（否则覆盖表在撒谎）；
 * - 每条**反例**必须零命中（否则"相似但非秘密"的声明是假的，会误导后续调规则）；
 * - 所有正例必须是**明显的假值**（含 `FAKE` / 占位标记），不得看起来像真凭据。
 */
import { describe, expect, it } from "vitest";

import { CREDENTIAL_DETECTION_FIXTURES } from "../../../packages/core/src/testing/credential-detection-fixtures.js";
import { selectDetectorRulesForModelRead } from "../../../packages/core/src/tools/credential-detector-registry.js";

const rules = selectDetectorRulesForModelRead();

function matchedRuleIdentifiers(content: string): string[] {
  return rules.filter((rule) => rule.pattern.test(content)).map((rule) => rule.identifier);
}

describe("夹具结构", () => {
  it("① 夹具 ID 唯一，字段齐备，isPositive 为布尔", () => {
    expect(CREDENTIAL_DETECTION_FIXTURES.length).toBeGreaterThan(0);
    const identifiers = CREDENTIAL_DETECTION_FIXTURES.map((fixture) => fixture.fixtureIdentifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const fixture of CREDENTIAL_DETECTION_FIXTURES) {
      expect(fixture.fixtureIdentifier.trim()).not.toBe("");
      expect(fixture.category.trim()).not.toBe("");
      expect(fixture.note.trim()).not.toBe("");
      expect(typeof fixture.isPositive).toBe("boolean");
    }
  });

  it("② ID 前缀与 isPositive 一致（pos / neg 不得写反）", () => {
    for (const fixture of CREDENTIAL_DETECTION_FIXTURES) {
      if (fixture.fixtureIdentifier.includes("-pos-")) {
        expect(fixture.isPositive, `${fixture.fixtureIdentifier} 应标注为正例`).toBe(true);
      }
      if (fixture.fixtureIdentifier.includes("-neg-")) {
        expect(fixture.isPositive, `${fixture.fixtureIdentifier} 应标注为反例`).toBe(false);
      }
    }
  });

  it("③ 正例都是明显的假值（含 FAKE/占位标记，不是真凭据）", () => {
    for (const fixture of CREDENTIAL_DETECTION_FIXTURES.filter((entry) => entry.isPositive)) {
      expect(
        fixture.content,
        `${fixture.fixtureIdentifier} 的正例没有明显假值标记：${fixture.content}`,
      ).toMatch(/(fake|dummy|example|placeholder|0{8,})/iu);
    }
  });

  it("④ 导出是纯数据（不含函数，不参与生产判定）", () => {
    for (const fixture of CREDENTIAL_DETECTION_FIXTURES) {
      for (const value of Object.values(fixture)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });
});

describe("夹具与检测规则的一致性", () => {
  it("⑤ 每条**正例**都被至少一条规则命中", () => {
    const undetected = CREDENTIAL_DETECTION_FIXTURES.filter(
      (fixture) => fixture.isPositive && matchedRuleIdentifiers(fixture.content).length === 0,
    ).map((fixture) => fixture.fixtureIdentifier);
    expect(undetected).toEqual([]);
  });

  it("⑥ 每条**反例**都零命中（相似但非秘密必须真的不命中）", () => {
    const falselyDetected = CREDENTIAL_DETECTION_FIXTURES.filter(
      (fixture) => !fixture.isPositive && matchedRuleIdentifiers(fixture.content).length > 0,
    ).map((fixture) => ({
      fixtureIdentifier: fixture.fixtureIdentifier,
      matched: matchedRuleIdentifiers(fixture.content),
    }));
    expect(falselyDetected).toEqual([]);
  });

  it("⑦ 正例覆盖多个类别（不是只测一种凭据）", () => {
    const categories = new Set(
      CREDENTIAL_DETECTION_FIXTURES.filter((fixture) => fixture.isPositive).map(
        (fixture) => fixture.category,
      ),
    );
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });
});
