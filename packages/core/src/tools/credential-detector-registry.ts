/**
 * SEC-02-02（2026-10-28）：**版本化凭据检测器注册表**（单一来源，两套出口策略）。
 *
 * 卡内要求：建立版本化检测器注册表，分别产生"**阻断模型读取**"与"**日志掩码**"两套策略，
 * 不能把全部内容脱敏后自动放行敏感文件；覆盖已支持厂商格式、Authorization/Cookie、
 * GitHub 新旧 token、私钥含多行与加密头、连接串、结构化敏感字段；只用人工构造的假凭据。
 *
 * 设计要点：
 * - **单一目录**：每条规则只在这里定义一次（`detectionPattern` + 可选 `maskingPattern`）。
 * - **两套出口**：`selectDetectorRulesForModelRead()` 只给"能不能给模型看"的判定用；
 *   `selectCredentialMaskingRules()` 只给日志/错误消息脱敏用。
 *   **掩码不等于放行** —— 调掩码策略不会改变模型读取的判定。
 * - **版本化**：`CREDENTIAL_DETECTOR_CATALOG_VERSION` 随规则变动递增，扫描结果带该版本。
 * - **保守**：无稳定前缀的秘密（密码/自定义 key）靠字段语义检测；识别不了就交给隔离与
 *   受保护来源规则，**不**宣称"任何裸值都能识别"。
 */

/** 注册表版本：规则增删改即递增。 */
export const CREDENTIAL_DETECTOR_CATALOG_VERSION = 1;

/** 规则只对哪条出口生效。 */
export type CredentialDetectorAppliesTo = "model-read" | "log-mask" | "both";

export interface CredentialDetectorRule {
  /** 稳定规则 ID（结果与覆盖表都用它）。 */
  readonly ruleIdentifier: string;
  readonly category: string;
  /** 已接入厂商（无厂商归属时为 null）。 */
  readonly vendor: string | null;
  /** 检测用（**不带 `g`**，避免 `test` 的 lastIndex 副作用）。 */
  readonly detectionPattern: RegExp;
  /** 掩码用（带 `g`；`null` 表示该规则只用于阻断、不用于日志替换）。 */
  readonly maskingPattern: RegExp | null;
  /** 掩码替换（可含捕获组引用）。 */
  readonly maskingReplacement: string | null;
  readonly appliesTo: CredentialDetectorAppliesTo;
  readonly description: string;
}

const REDACTED = "[REDACTED]";

/**
 * 规则目录。
 *
 * 说明：前缀类（`sk-`/`ghp_`/`AKIA`…）可稳定识别；无固定格式的秘密（密码、自定义 key）
 * 只能靠**字段名 + 结构**判定，且必须承认存在漏判（见 SEC-02-05 覆盖表）。
 */
const CREDENTIAL_DETECTOR_RULES: readonly CredentialDetectorRule[] = [
  {
    ruleIdentifier: "vendor:anthropic-api-key",
    category: "api-key",
    vendor: "anthropic",
    detectionPattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
    maskingPattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "Anthropic 形态 API key（`sk-ant-` 前缀）",
  },
  {
    ruleIdentifier: "vendor:openai-style-api-key",
    category: "api-key",
    vendor: "openai-compatible",
    detectionPattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{8,}/,
    maskingPattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{8,}/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "OpenAI 兼容厂商的裸 `sk-` key（含 DeepSeek/Moonshot 等兼容端点）",
  },
  {
    ruleIdentifier: "vendor:moonshot-api-key",
    category: "api-key",
    vendor: "moonshot",
    detectionPattern: /\bsk-[A-Za-z0-9]{32,}\b/,
    maskingPattern: null,
    maskingReplacement: null,
    appliesTo: "model-read",
    description: "Moonshot 形态（长 `sk-` 裸值；已被上一条覆盖，单独登记便于覆盖表核对）",
  },
  {
    ruleIdentifier: "vcs:github-token-classic",
    category: "vcs-token",
    vendor: "github",
    detectionPattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
    maskingPattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "GitHub 经典 token（ghp_/gho_/ghu_/ghs_/ghr_）",
  },
  {
    ruleIdentifier: "vcs:github-token-fine-grained",
    category: "vcs-token",
    vendor: "github",
    detectionPattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    maskingPattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "GitHub 细粒度 token（github_pat_）",
  },
  {
    ruleIdentifier: "vcs:gitlab-token",
    category: "vcs-token",
    vendor: "gitlab",
    detectionPattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/,
    maskingPattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "GitLab personal access token（glpat-）",
  },
  {
    ruleIdentifier: "package:npm-token",
    category: "package-token",
    vendor: "npm",
    detectionPattern: /\bnpm_[A-Za-z0-9]{36}\b/,
    maskingPattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "npm access token（npm_ + 36 位）",
  },
  {
    ruleIdentifier: "cloud:aws-access-key-id",
    category: "cloud-credential",
    vendor: "aws",
    detectionPattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    maskingPattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "AWS 长期/临时访问标识（AKIA/ASIA）",
  },
  {
    ruleIdentifier: "cloud:aws-secret-access-key",
    category: "cloud-credential",
    vendor: "aws",
    detectionPattern: /aws_?secret_?access_?key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i,
    maskingPattern: /aws_?secret_?access_?key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/gi,
    maskingReplacement: `aws_secret_access_key=${REDACTED}`,
    appliesTo: "both",
    description: "AWS secret access key 字段（40 位 base64 形态）",
  },
  {
    ruleIdentifier: "http:authorization-header",
    category: "http-auth",
    vendor: null,
    detectionPattern: /^[ \t]*Authorization[ \t]*:[ \t]*(?:Bearer|Basic)[ \t]+\S+/im,
    maskingPattern: /(Authorization[ \t]*:[ \t]*(?:Bearer|Basic)[ \t]+)\S+/gi,
    maskingReplacement: `$1${REDACTED}`,
    appliesTo: "both",
    description: "Authorization: Bearer/Basic（Basic 编码不是脱敏）",
  },
  {
    ruleIdentifier: "http:sensitive-cookie",
    category: "http-auth",
    vendor: null,
    detectionPattern: /(?:^|\n)[ \t]*(?:Cookie|Set-Cookie)[ \t]*:[ \t]*[^\n]*(?:session|sessid|token|auth)[^\n]*/i,
    maskingPattern: /((?:Cookie|Set-Cookie)[ \t]*:[ \t]*[^\n]*(?:session|sessid|token|auth)[^\n]*)/gi,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "含会话/令牌字段的 Cookie/Set-Cookie",
  },
  {
    ruleIdentifier: "auth:jwt",
    category: "session-token",
    vendor: null,
    detectionPattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    maskingPattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    maskingReplacement: REDACTED,
    appliesTo: "both",
    description: "JWT 形态（结构不代表有效，也不因未验签就当安全）",
  },
  {
    ruleIdentifier: "key:pem-private-key",
    category: "private-key",
    vendor: null,
    detectionPattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    maskingPattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----|$)/g,
    maskingReplacement: `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
    appliesTo: "both",
    description: "PEM/OpenSSH/PGP 私钥（含加密头）；掩码覆盖整段正文",
  },
  {
    ruleIdentifier: "db:connection-string-password",
    category: "connection-string",
    vendor: null,
    detectionPattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s:@/]+:[^\s:@/]+@/,
    maskingPattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/)[^\s:@/]+:[^\s:@/]+@/g,
    maskingReplacement: `$1${REDACTED}:${REDACTED}@`,
    appliesTo: "both",
    description: "带密码的数据库/消息服务连接串",
  },
  {
    ruleIdentifier: "field:structured-credential",
    category: "structured-field",
    vendor: null,
    detectionPattern:
      /"(?:api[_-]?key|apikey|secret|token|password|access[_-]?key|client[_-]?secret)"\s*:\s*"[^"]{8,}"/i,
    maskingPattern:
      /("(?:api[_-]?key|apikey|secret|token|password|access[_-]?key|client[_-]?secret)"\s*:\s*")[^"]{8,}"/gi,
    maskingReplacement: `$1${REDACTED}"`,
    appliesTo: "both",
    description: "结构化敏感字段（JSON/配置里的 key/secret/token/password）",
  },
  {
    ruleIdentifier: "field:assignment-credential",
    category: "structured-field",
    vendor: null,
    detectionPattern:
      /(?:api[_-]?key|apikey|secret|token|password|access[_-]?key|client[_-]?secret)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    maskingPattern:
      /((?:api[_-]?key|apikey|secret|token|password|access[_-]?key|client[_-]?secret)\s*[=:]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
    maskingReplacement: `$1${REDACTED}`,
    appliesTo: "both",
    description: "赋值式敏感字段（env/ini/命令行）",
  },
];

export function listCredentialDetectorRules(): readonly CredentialDetectorRule[] {
  return CREDENTIAL_DETECTOR_RULES;
}

/** 只看这条规则是否用于某出口。 */
function ruleAppliesTo(
  rule: CredentialDetectorRule,
  target: "model-read" | "log-mask",
): boolean {
  return rule.appliesTo === "both" || rule.appliesTo === target;
}

/**
 * **阻断模型读取**用的规则视图（结构性匹配 `SensitiveScanRule`）。
 *
 * 不改写任何内容：只回答"这段内容能不能给模型看"。
 */
export function selectDetectorRulesForModelRead(): Array<{
  identifier: string;
  pattern: RegExp;
}> {
  return CREDENTIAL_DETECTOR_RULES.filter((rule) =>
    ruleAppliesTo(rule, "model-read"),
  ).map((rule) => ({
    // 每次返回新的非全局正则，避免 `test` 的 lastIndex 状态跨次污染。
    identifier: rule.ruleIdentifier,
    pattern: new RegExp(rule.detectionPattern.source, rule.detectionPattern.flags),
  }));
}

export interface CredentialMaskingRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * **日志掩码**用的规则视图。
 *
 * 注意：掩码是"日志不得留原文"的要求，**不构成**"可以给模型看"的许可。
 */
export function selectCredentialMaskingRules(): CredentialMaskingRule[] {
  return CREDENTIAL_DETECTOR_RULES.filter(
    (rule) =>
      ruleAppliesTo(rule, "log-mask") &&
      rule.maskingPattern !== null &&
      rule.maskingReplacement !== null,
  ).map((rule) => ({
    name: rule.ruleIdentifier.replace(/[:]/g, "-"),
    pattern: new RegExp(rule.maskingPattern!.source, rule.maskingPattern!.flags),
    replacement: rule.maskingReplacement!,
  }));
}
