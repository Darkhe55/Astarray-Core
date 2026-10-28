/**
 * 敏感信息脱敏层（T02）。
 * 用于日志、错误消息、快照与交付报告；API key、Authorization 和用户 secret 一律替换为占位符。
 *
 * SEC-02-02（2026-10-28）：默认规则改为从**凭据检测器注册表**的"日志掩码"视图生成
 * （`credential-detector-registry.ts`）。规则只维护一份；掩码策略**不构成**
 * "内容可以给模型看"的许可 —— 模型读取由独立的阻断策略判定。
 */
import { selectCredentialMaskingRules } from "../tools/credential-detector-registry.js";

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export const REDACTED_PLACEHOLDER = "[REDACTED]";

export function createDefaultRedactionRules(): RedactionRule[] {
  return selectCredentialMaskingRules().map((rule) => ({
    name: rule.name,
    pattern: rule.pattern,
    replacement: rule.replacement,
  }));
}

export class Redactor {
  constructor(private readonly rules: RedactionRule[] = createDefaultRedactionRules()) {}

  redact(input: string): string {
    let output = input;
    for (const rule of this.rules) {
      output = output.replace(rule.pattern, rule.replacement);
    }
    return output;
  }

  /** 断言式校验：包含任一敏感模式即视为脱敏失败（供测试与审计使用）。 */
  containsSensitivePattern(input: string): boolean {
    // 先剔除已替换的占位符，避免规则与其自身输出自匹配
    const withoutPlaceholders = input.split(REDACTED_PLACEHOLDER).join("");
    return this.rules.some((rule) => {
      rule.pattern.lastIndex = 0;
      return rule.pattern.test(withoutPlaceholders);
    });
  }
}
