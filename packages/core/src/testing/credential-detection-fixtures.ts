/**
 * SEC-02-05（2026-10-28）：凭据检测**覆盖核对夹具**。
 *
 * 用途：给 `SEC02_CREDENTIAL_COVERAGE.md` 提供可引用的夹具 ID，便于后续编写测试或人工核对
 * 时"正例命中 / 相似非秘密不命中"有明确对象。
 *
 * **纪律**：
 * - 全部为**人工构造的假值**（`FAKE` 前缀或明显占位），不是真实凭据，也不指向真实账户；
 * - 本文件不联网、不读取真实凭据、不参与生产判定（只在核对/测试中使用）；
 * - 夹具 ID 一旦发布不要改写（覆盖文档与后续测试按 ID 引用）。
 */
export interface CredentialDetectionFixture {
  /** 稳定夹具 ID（覆盖表按它引用）。 */
  readonly fixtureIdentifier: string;
  /** 对应覆盖表的类别。 */
  readonly category: string;
  /** 正例 = 应被规则识别；反例 = 相似但**不是**秘密。 */
  readonly isPositive: boolean;
  readonly content: string;
  readonly note: string;
}

export const CREDENTIAL_DETECTION_FIXTURES: readonly CredentialDetectionFixture[] = [
  {
    fixtureIdentifier: "vendor-anthropic-pos-1",
    category: "vendor-api-key",
    isPositive: true,
    content: "ANTHROPIC_API_KEY=sk-ant-FAKE0000000000000000000000",
    note: "Anthropic 形态（sk-ant- 前缀）",
  },
  {
    fixtureIdentifier: "vendor-anthropic-neg-1",
    category: "vendor-api-key",
    isPositive: false,
    content: "sk-ant-short",
    note: "同前缀但长度不足 20，不应命中",
  },
  {
    fixtureIdentifier: "vendor-openai-pos-1",
    category: "vendor-api-key",
    isPositive: true,
    content: "OPENAI_API_KEY=sk-FAKE0000000000000000",
    note: "OpenAI 兼容裸 sk- 形态",
  },
  {
    fixtureIdentifier: "vendor-openai-neg-1",
    category: "vendor-api-key",
    isPositive: false,
    content: "the sk- prefix is documented here",
    note: "文本中提到前缀但没有 key 主体",
  },
  {
    fixtureIdentifier: "vcs-github-classic-pos-1",
    category: "vcs-token",
    isPositive: true,
    content: "token=ghp_FAKE0000000000000000",
    note: "GitHub 经典 token（ghp_）",
  },
  {
    fixtureIdentifier: "vcs-github-fine-grained-pos-1",
    category: "vcs-token",
    isPositive: true,
    content: "token=github_pat_FAKE000000000000000000",
    note: "GitHub 细粒度 token（github_pat_）",
  },
  {
    fixtureIdentifier: "vcs-github-neg-1",
    category: "vcs-token",
    isPositive: false,
    content: "ghp_ discussed in the docs",
    note: "提到前缀但没有 token 主体",
  },
  {
    fixtureIdentifier: "vcs-gitlab-pos-1",
    category: "vcs-token",
    isPositive: true,
    content: "glpat-FAKE0000000000000000",
    note: "GitLab PAT",
  },
  {
    fixtureIdentifier: "package-npm-pos-1",
    category: "package-token",
    isPositive: true,
    content: "//registry.example.invalid/:_authToken=npm_FAKE000000000000000000000000000000",
    note: "npm token（npm_ + 36 位）",
  },
  {
    fixtureIdentifier: "cloud-aws-access-key-pos-1",
    category: "cloud-credential",
    isPositive: true,
    content: "aws_access_key_id = AKIAFAKE0000000000",
    note: "AWS 访问标识（AKIA + 16 位大写）",
  },
  {
    fixtureIdentifier: "cloud-aws-access-key-neg-1",
    category: "cloud-credential",
    isPositive: false,
    content: "akiafake0000000000",
    note: "小写形态，不是 AWS 标识",
  },
  {
    fixtureIdentifier: "cloud-aws-secret-pos-1",
    category: "cloud-credential",
    isPositive: true,
    content: "aws_secret_access_key=FAKE0000000000000000000000000000000000FAKE",
    note: "AWS secret 字段（40 位形态）",
  },
  {
    fixtureIdentifier: "cloud-azure-neg-1",
    category: "cloud-credential",
    isPositive: false,
    content: "AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000",
    note: "无固定格式云凭据：**当前无规则**，仅按来源/字段隔离（用于记录缺口）",
  },
  {
    fixtureIdentifier: "http-authorization-bearer-pos-1",
    category: "http-auth",
    isPositive: true,
    content: "Authorization: Bearer FAKE0000000000000000",
    note: "Authorization: Bearer",
  },
  {
    fixtureIdentifier: "http-authorization-neg-1",
    category: "http-auth",
    isPositive: false,
    content: "Authorization: none",
    note: "没有 Bearer/Basic 方案与凭据",
  },
  {
    fixtureIdentifier: "http-cookie-session-pos-1",
    category: "http-auth",
    isPositive: true,
    content: "Cookie: session=FAKE0000000000000000; theme=dark",
    note: "含 session 的 Cookie",
  },
  {
    fixtureIdentifier: "http-cookie-consent-neg-1",
    category: "http-auth",
    isPositive: false,
    content: "Cookie: consent=accepted; lang=zh-CN",
    note: "非认证 Cookie",
  },
  {
    fixtureIdentifier: "auth-jwt-pos-1",
    category: "session-token",
    isPositive: true,
    content: "eyJFAKEHEADER00.eyJFAKEPAYLOAD00.FAKEsignature00",
    note: "JWT 三段形态",
  },
  {
    fixtureIdentifier: "auth-jwt-neg-1",
    category: "session-token",
    isPositive: false,
    content: "eyJFAKEHEADER00.eyJFAKEPAYLOAD00",
    note: "只有两段，不是 JWT",
  },
  {
    fixtureIdentifier: "key-pem-pos-1",
    category: "private-key",
    isPositive: true,
    content:
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nFAKE0000000000000000\n-----END ENCRYPTED PRIVATE KEY-----",
    note: "加密私钥头（多行）",
  },
  {
    fixtureIdentifier: "key-public-neg-1",
    category: "private-key",
    isPositive: false,
    content: "-----BEGIN PUBLIC KEY-----\nFAKE0000000000000000\n-----END PUBLIC KEY-----",
    note: "公钥不是私钥",
  },
  {
    fixtureIdentifier: "db-connection-pos-1",
    category: "connection-string",
    isPositive: true,
    content: "postgres://fake_user:fake_password@db.example.invalid:5432/app",
    note: "带密码的连接串（域名用 .invalid）",
  },
  {
    fixtureIdentifier: "db-connection-neg-1",
    category: "connection-string",
    isPositive: false,
    content: "postgres://db.example.invalid:5432/app",
    note: "无密码的连接串",
  },
  {
    fixtureIdentifier: "field-structured-secret-pos-1",
    category: "structured-field",
    isPositive: true,
    content: '{"client_secret": "FAKE0000000000000000"}',
    note: "JSON 敏感字段",
  },
  {
    fixtureIdentifier: "field-structured-flag-neg-1",
    category: "structured-field",
    isPositive: false,
    content: '{"token": "enabled"}',
    note: "字段名像凭据但值是布尔语义（长度不足 8）",
  },
  {
    fixtureIdentifier: "field-gcp-private-key-pos-1",
    category: "service-account",
    isPositive: true,
    content:
      '{"type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nFAKE0000\\n-----END PRIVATE KEY-----"}',
    note: "服务账户 JSON：靠 PEM 头命中；字段名 private_key **不在**字段规则里（记录缺口）",
  },
];
