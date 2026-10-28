# ADR-0068 版本化凭据检测器注册表：阻断与掩码两套出口（SEC-02-02）

- 状态：部分采纳（注册表 + 两套视图已接；覆盖表与通道矩阵未做）
- 日期：2026-10-28
- 来源：[SEC-02](../tasks/SEC02_LOCAL_SCAN_COVERAGE.md) 检查点 02
- 相关：ADR-0067（四态扫描）、`infra/redaction.ts`

## 1. 背景（实测）

规则此前**两套各维护**：

- `sensitive-content-access-policy.ts` 的 `DEFAULT_DLP_PATTERNS`（api-key/aws/private-key/github/connection-string）；
- `infra/redaction.ts` 的 `createDefaultRedactionRules()`（authorization/sk-/AKIA/json 字段/赋值）。

后果：**裸 `sk-` 只有掩码层有、DLP 层没有**；私钥多行/加密头、GitHub 细粒度 token、
npm/GitLab token、JWT、敏感 Cookie 只覆盖了一部分；两层漂移无法核对。

## 2. 契约（冻结）

1. **单一目录**：每条规则只在 `credential-detector-registry.ts` 定义一次，
   `CREDENTIAL_DETECTOR_CATALOG_VERSION` 随规则变动递增。
2. **两套出口，互不授权**：
   - `selectDetectorRulesForModelRead()` → 只回答"能不能给模型看"；
   - `selectCredentialMaskingRules()` → 只回答"日志里怎么替换"。
   **掩码不等于放行**：执行掩码不会改变模型读取判定（反向亦然）。
3. **覆盖范围**（本轮目录已包含）：
   - 厂商 key：Anthropic `sk-ant-`、OpenAI 兼容裸 `sk-`（含 DeepSeek/Moonshot 等兼容端点）、
     Moonshot 长裸值（单独登记便于核对）；
   - VCS/包仓库：GitHub 经典 `gh[pousr]_`、细粒度 `github_pat_`、GitLab `glpat-`、npm `npm_`；
   - 云：AWS `AKIA`/`ASIA` + `aws_secret_access_key` 字段；
   - HTTP：`Authorization: Bearer/Basic`、含 session/token/auth 的 `Cookie`/`Set-Cookie`；
   - 会话令牌：JWT 形态；
   - 私钥：PEM/OpenSSH/PGP **含加密头**（掩码覆盖整段正文）；
   - 连接串：带密码的 postgres/mysql/mongodb/redis/amqp；
   - 结构化字段：JSON 字段与 `key=value` 赋值。
4. **不宣称全覆盖**：无稳定前缀的自定义 key/密码只能靠字段语义；**识别不了就交给受保护来源
   与隔离规则**，不写"任意裸值都能识别"。
5. **只用人工构造的假凭据**：本窗口没有读取真实凭据、没有联网验证 token 可用性。
6. **正则状态安全**：检测视图返回**非全局**新正则（避免 `test` 的 `lastIndex` 跨次污染）；
   掩码视图返回全局新正则。

## 3. 生产调用链（源码位置）

```
sensitive-content-scan-contract.ts
└─ DEFAULT_SENSITIVE_SCAN_RULES = selectDetectorRulesForModelRead()      tools/credential-detector-registry.ts
   └─ scanSensitiveContent（四态，SEC-02-01） → 非 clean 即拒绝
infra/redaction.ts
└─ createDefaultRedactionRules() = selectCredentialMaskingRules().map(...)   （同一目录的掩码视图）
   └─ Redactor.redact（日志/错误消息）
```

## 4. 未完成（如实）

- **覆盖表（SEC-02-05）未写**：`SEC02_CREDENTIAL_COVERAGE.md` 尚未交付（每类要列规则 ID/版本、
  格式依据、裸值识别能力、上下文要求、正反例夹具 ID、已接入口、限制、验证状态）。
- **通道矩阵（SEC-02-06）未做**：哪些入口把内容送到模型/日志，没有逐通道登记。
- **高熵信号未使用**：没有"仅凭熵判泄露"的补充信号（也不应以熵单独证明安全）。
- **部分厂商无稳定前缀**：智谱/云知声等未登记（没有可稳定识别的前缀；只靠字段语义会落到
  `structured-field` 规则，且可能漏判）。
- **日志换行注入防护未做**：掩码输出里若含换行仍可能伪造日志行。
- **未验证**：没有用人工假凭据跑过任何一条规则的命中/掩码；也没有核对"掩码视图与阻断视图
  覆盖差异"的自动化守卫。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收、未使用真实凭据。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
