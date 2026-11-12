/**
 * 凭据检测器注册表（此前 `tests/` 零引用）：单一目录、两套出口、版本化。
 *
 * 核心安全断言：**掩码不等于放行** —— 日志脱敏后文本仍不得送进模型；
 * 检测正则不得带 `g`（避免 lastIndex 副作用），掩码正则必须带 `g`。
 * 所有样本均为人工构造的假凭据。
 */
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_DETECTOR_CATALOG_VERSION,
  listCredentialDetectorRules,
  selectCredentialMaskingRules,
  selectDetectorRulesForModelRead,
} from "../../../packages/core/src/tools/credential-detector-registry.js";

/** 人工构造的假凭据（不是任何真实密钥）。 */
const FAKE_CREDENTIAL_SAMPLES: ReadonlyArray<{ label: string; text: string; expectedRule: string }> = [
  { label: "anthropic", text: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", expectedRule: "vendor:anthropic-api-key" },
  { label: "openai-style", text: "sk-BBBBBBBBCCCCCCCC", expectedRule: "vendor:openai-style-api-key" },
  { label: "github-classic", text: "ghp_AAAAAAAAAAAAAAAAAAAA", expectedRule: "vcs:github-token-classic" },
  { label: "aws-access-key", text: "AKIAAAAAAAAAAAAAAAAA", expectedRule: "cloud:aws-access-key-id" },
];

describe("注册表结构", () => {
  it("① 版本为正整数、规则 id 唯一、每条都有检测正则", () => {
    expect(CREDENTIAL_DETECTOR_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    const rules = listCredentialDetectorRules();
    expect(rules.length).toBeGreaterThan(0);
    const identifiers = rules.map((rule) => rule.ruleIdentifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const rule of rules) {
      expect(rule.detectionPattern).toBeInstanceOf(RegExp);
      expect(rule.description.trim()).not.toBe("");
    }
  });

  it("② 检测正则不带 g（避免 test 的 lastIndex 副作用）", () => {
    for (const rule of listCredentialDetectorRules()) {
      expect(rule.detectionPattern.flags).not.toContain("g");
    }
  });

  it("③ 掩码正则带 g 且有替换文本；掩码规则名不含冒号", () => {
    for (const rule of listCredentialDetectorRules()) {
      if (rule.maskingPattern === null) {
        expect(rule.maskingReplacement).toBeNull();
        continue;
      }
      expect(rule.maskingPattern.flags).toContain("g");
      expect(rule.maskingReplacement).not.toBeNull();
    }
    for (const maskingRule of selectCredentialMaskingRules()) {
      expect(maskingRule.name).not.toContain(":");
      expect(maskingRule.pattern.flags).toContain("g");
    }
  });

  it("④ 模型读取视图覆盖所有 appliesTo 为 model-read/both 的规则", () => {
    const expected = listCredentialDetectorRules().filter(
      (rule) => rule.appliesTo === "model-read" || rule.appliesTo === "both",
    );
    expect(selectDetectorRulesForModelRead().map((rule) => rule.identifier).sort()).toEqual(
      expected.map((rule) => rule.ruleIdentifier).sort(),
    );
  });

  it("⑤ 掩码视图不含只阻断、不脱敏的规则（如 moonshot 长 sk-）", () => {
    const maskingIdentifiers = new Set(
      selectCredentialMaskingRules().map((rule) => rule.name.replace(/-/g, ":")),
    );
    for (const rule of listCredentialDetectorRules()) {
      if (rule.maskingPattern === null) {
        expect(maskingIdentifiers.has(rule.ruleIdentifier)).toBe(false);
      }
    }
  });
});

describe("识别与脱敏", () => {
  it("⑥ 假凭据被对应规则命中", () => {
    const rules = selectDetectorRulesForModelRead();
    for (const sample of FAKE_CREDENTIAL_SAMPLES) {
      const matched = rules
        .filter((rule) => rule.pattern.test(sample.text))
        .map((rule) => rule.identifier);
      expect(matched, `${sample.label} 应命中 ${sample.expectedRule}`).toContain(sample.expectedRule);
    }
  });

  it("⑦ 普通说明文本不被误报", () => {
    const benign = [
      "这份文档说明如何配置环境变量与日志级别。",
      "请把 API key 存在本机凭据库里，不要写进代码。",
      "本次运行共处理 3 个文档。",
    ];
    for (const text of benign) {
      const matched = selectDetectorRulesForModelRead().filter((rule) => rule.pattern.test(text));
      expect(matched.map((rule) => rule.identifier)).toEqual([]);
    }
  });

  it("⑧ 掩码后原文消失：脱敏文本不再含原凭据", () => {
    for (const sample of FAKE_CREDENTIAL_SAMPLES) {
      let masked = sample.text;
      for (const maskingRule of selectCredentialMaskingRules()) {
        masked = masked.replace(maskingRule.pattern, maskingRule.replacement);
      }
      expect(masked).not.toContain(sample.text);
      expect(masked).toContain("[REDACTED]");
    }
  });

  it("⑨ **掩码不等于放行**：脱敏只改变日志文本，不改变模型读取判定，也不改变规则集", () => {
    const sample = FAKE_CREDENTIAL_SAMPLES[0]!;
    const beforeRules = selectDetectorRulesForModelRead().map((rule) => rule.identifier);
    /** 调用掩码视图不应影响模型读取视图。 */
    selectCredentialMaskingRules();
    const afterRules = selectDetectorRulesForModelRead().map((rule) => rule.identifier);
    expect(afterRules).toEqual(beforeRules);

    /** 原文被阻断。 */
    const blockedForOriginal = beforeRules.length > 0 &&
      selectDetectorRulesForModelRead().some((rule) => rule.pattern.test(sample.text));
    expect(blockedForOriginal).toBe(true);

    /** 脱敏后文本不再命中该规则 —— 说明原文真的被替换掉了。 */
    let masked = sample.text;
    for (const maskingRule of selectCredentialMaskingRules()) {
      masked = masked.replace(maskingRule.pattern, maskingRule.replacement);
    }
    expect(selectDetectorRulesForModelRead().some((rule) => rule.pattern.test(masked))).toBe(false);
  });

  it("⑩ 每次返回新的正则实例：多次调用判定稳定，互不污染", () => {
    const first = selectDetectorRulesForModelRead();
    const second = selectDetectorRulesForModelRead();
    expect(first[0]?.pattern).not.toBe(second[0]?.pattern);

    const sample = FAKE_CREDENTIAL_SAMPLES[0]!.text;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const matched = selectDetectorRulesForModelRead().some((rule) => rule.pattern.test(sample));
      expect(matched).toBe(true);
    }
  });
});
