# SEC-02-05 凭据类型覆盖表

日期：2026-10-28。目录版本：`CREDENTIAL_DETECTOR_CATALOG_VERSION = 1`；
扫描契约版本：`SENSITIVE_SCAN_RULE_SET_VERSION`（与目录版本一致）。
夹具：`packages/core/src/testing/credential-detection-fixtures.ts`（**全部人工构造的假值**）。

> **结论口径**：本表没有一行是"已验证" —— 本窗口不编写/不运行测试。
> 每行只能落在 **已实现未验证（implemented-unverified）** / **部分支持** / **不支持** 三类。
> **空白行不得被汇总成"全部常见密钥支持"**。

## 1. 覆盖表

| 类别 | 规则 ID（版本） | 格式依据 | 裸值识别 | 上下文要求 | 正例夹具 | 反例夹具 | 已接入口 | 限制 | 结论 |
|---|---|---|---|---|---|---|---|---|---|
| 已接入厂商 API key（Anthropic） | `vendor:anthropic-api-key`（v1） | 公开前缀惯例 `sk-ant-`；**本轮未联网核对官方文档** | 是（≥20 字符主体） | 无 | `vendor-anthropic-pos-1` | `vendor-anthropic-neg-1` | 模型读取阻断 + 日志掩码 | 前缀是惯例而非规范；厂商改名即失效 | 已实现未验证 |
| 已接入厂商 API key（OpenAI 兼容裸 `sk-`） | `vendor:openai-style-api-key`（v1） | 公开前缀惯例 `sk-` | 是（≥8 字符主体） | 无 | `vendor-openai-pos-1` | `vendor-openai-neg-1` | 同上 | 与 Anthropic 规则靠 `(?!ant-)` 区分；误报面较大 | 已实现未验证 |
| 已接入厂商 API key（Moonshot 长裸值） | `vendor:moonshot-api-key`（v1） | 长 `sk-` 裸值 | 是 | 无 | 复用 `vendor-openai-pos-1` | `vendor-openai-neg-1` | 同上 | 与上一行重叠（单独登记只为覆盖核对） | 已实现未验证 |
| 已接入厂商 API key（智谱 / 云知声 等） | — | 无稳定公开前缀 | **否** | 只能靠字段语义 | — | `cloud-azure-neg-1`（同类缺口示例） | 字段规则兜底 | **可能漏判**；不宣称支持 | **不支持**（无稳定格式） |
| GitHub 经典 token | `vcs:github-token-classic`（v1） | `gh[pousr]_` 前缀 | 是 | 无 | `vcs-github-classic-pos-1` | `vcs-github-neg-1` | 模型读取阻断 + 日志掩码 | 长度下限 16 为经验值 | 已实现未验证 |
| GitHub 细粒度 token | `vcs:github-token-fine-grained`（v1） | `github_pat_` 前缀 | 是 | 无 | `vcs-github-fine-grained-pos-1` | `vcs-github-neg-1` | 同上 | 同上 | 已实现未验证 |
| GitLab PAT | `vcs:gitlab-token`（v1） | `glpat-` 前缀 | 是 | 无 | `vcs-gitlab-pos-1` | `vcs-github-neg-1`（相似前缀） | 同上 | 同上 | 已实现未验证 |
| npm token | `package:npm-token`（v1） | `npm_` + 36 位 | 是 | 无 | `package-npm-pos-1` | — | 同上 | 固定长度假设；格式变化即漏判 | 已实现未验证 |
| AWS 访问标识 | `cloud:aws-access-key-id`（v1） | `AKIA`/`ASIA` + 16 位大写 | 是 | 无 | `cloud-aws-access-key-pos-1` | `cloud-aws-access-key-neg-1` | 同上 | 只识别标识，不证明其有效 | 已实现未验证 |
| AWS secret 访问密钥 | `cloud:aws-secret-access-key`（v1） | 字段名 + 40 位 base64 形态 | 否（**必须**有字段名） | 字段名 `aws_secret_access_key` | `cloud-aws-secret-pos-1` | — | 同上 | 无字段名的裸 40 位串**不报**（无法与普通串区分） | 部分支持 |
| Azure / GCP 凭据 | — | 多为无固定格式（tenant/client id、service account JSON） | 否 | 依赖字段/来源 | `cloud-azure-neg-1` | 同左 | 字段规则兜底 | **未登记格式**；不宣称支持 | **不支持**（需 SEC-02-07 隔离或后续补规则） |
| `Authorization: Bearer/Basic` | `http:authorization-header`（v1） | HTTP 头语法 | 是 | 行首或换行后的头名 | `http-authorization-bearer-pos-1` | `http-authorization-neg-1` | 阻断 + 掩码 | Basic 的 base64 **不是**脱敏；掩码整段替换 | 已实现未验证 |
| 敏感 Cookie / Set-Cookie | `http:sensitive-cookie`（v1） | 头名 + 关键词（session/sessid/token/auth） | 是（需关键词） | 同上 | `http-cookie-session-pos-1` | `http-cookie-consent-neg-1` | 阻断 + 掩码 | 不含关键词的认证 Cookie 可能漏判 | 部分支持 |
| JWT | `auth:jwt`（v1） | 三段 base64url 形态 | 是 | 无 | `auth-jwt-pos-1` | `auth-jwt-neg-1` | 阻断 + 掩码 | 结构命中不等于有效；未验签不等于安全 | 已实现未验证 |
| OAuth access/refresh token | — | 无稳定前缀 | 否 | 依赖字段名（落入 `structured-field`） | `field-structured-secret-pos-1` | `field-structured-flag-neg-1` | 字段规则兜底 | **不单独登记**；字段名不同即漏判 | 部分支持 |
| PEM/OpenSSH/PGP 私钥（含加密头） | `key:pem-private-key`（v1） | `-----BEGIN … PRIVATE KEY-----` | 是（**只看头**） | 无 | `key-pem-pos-1` | `key-public-neg-1` | 阻断 + 掩码（整段正文） | 只看头：正文里混入的私钥若头被改动则不命中 | 已实现未验证 |
| 服务账户 JSON（`private_key` 字段） | 复用 `key:pem-private-key`（v1） | PEM 头 | 是（靠头部） | 无 | `field-gcp-private-key-pos-1` | — | 阻断 + 掩码 | **`private_key` 不在字段规则里**（字段规则只列 api_key/secret/token/password/access_key/client_secret） | 部分支持 |
| 带密码的数据库/消息连接串 | `db:connection-string-password`（v1） | `scheme://user:pass@` | 是 | 必须是带密码形态 | `db-connection-pos-1` | `db-connection-neg-1` | 阻断 + 掩码 | 无密码连接串不拦（正确）；非常见 scheme 不拦 | 已实现未验证 |
| Webhook / 带签名查询参数的访问链接 | — | 无稳定格式 | 否 | — | — | — | — | **未登记**（需按服务结构判定） | **不支持** |
| 无固定格式秘密（密码、自定义 key、随机 token） | `field:structured-credential` / `field:assignment-credential`（v1） | 字段名语义（api_key/secret/token/password/…） | 否（**必须**有字段名） | 字段名 + ≥8 字符值 | `field-structured-secret-pos-1` | `field-structured-flag-neg-1` | 阻断 + 掩码 | **不宣称任意裸值可识别**；主要靠受保护来源与隔离 | 部分支持 |

## 2. 明确的不支持与残余风险

1. **无字段名的裸秘密**（密码、自定义随机 token）无法仅靠内容可靠识别；
   已识别 secret 与未识别秘密之间的差距，**由 SEC-02-07 的凭据隔离与最小读取能力承担**，
   不以正则兜底。
2. **无稳定格式的云凭据**（Azure/GCP）当前**无规则**；只有落在结构化字段里才可能命中。
3. **webhook / 带签名 URL** 未登记；签名参数名不同即漏判。
4. **命中即整段拒绝**：本层不为"部分遮住秘密"提供路径（避免把正文残片算作安全）。
5. **格式依据未联网核对官方文档**：本轮是离线环境，规则依据是代码中的既有前缀惯例与公开常识；
   需要时应在有网环境核对并更新 `CREDENTIAL_DETECTOR_CATALOG_VERSION`。

## 3. 入口接线现状

- **仅两处**真正消费本目录：`scanSensitiveContent`（模型读取阻断）与 `redactor`（日志掩码）。
- 文档转换 / OCR / 插件 / MCP / 子进程输出 / 缓存 / 报告导出 / 模型最终出口：**未接**（SEC-02-06 的矩阵）。

## 4. 验证状态

**implemented-unverified**：本表逐行都是"规则存在"而非"行为已验证"。
本轮**没有**为任何夹具编写或运行测试；`SEC-02-06` 的通道矩阵与 `SEC-02-07` 的隔离仍未完成。
