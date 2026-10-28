# ADR-0067 敏感扫描四态契约（SEC-02-01）

- 状态：部分采纳（契约与扫描器已替换；规则覆盖/通道矩阵/外发门禁未做）
- 日期：2026-10-28
- 来源：[SEC-02](../tasks/SEC02_LOCAL_SCAN_COVERAGE.md) 检查点 01
- 相关：ADR-0018（敏感内容禁读）、ADR-0047（报告索引）

## 1. 背景（实测）

`DefaultDlpScanner` 旧实现：

```ts
const boundedContent = input.content.slice(0, 256 * 1024); // 常量叫 BYTES，实际是 UTF-16 code units
… return { matchedRuleCategory: null, isSensitive: false }; // 尾部未扫也报"安全"
```

后果：① 大文件/长内容**尾部完全不扫**却被判安全；② 非 ASCII 内容实际扫描量远小于"256 KiB 字节"；
③ 结果里没有规则版本、扫描范围、字节数与限制原因，调用方无法区分"扫完且干净"与"没扫完"。

## 2. 契约（冻结）

1. **四态结果**：`clean | sensitive | incomplete | error`。
   - **只有 `clean` 可以继续**；`sensitive` 拒绝，`incomplete`/`error` **同样拒绝**（fail-closed）。
2. **以 UTF-8 字节计量**：`Buffer.byteLength(content, "utf8")`；按字节切块，
   用**流式** `TextDecoder("utf-8", { fatal: true })` 解码 —— 不切断多字节字符，
   解码失败即 `error`（不静默替换成 U+FFFD）。
3. **不默默截尾**：超过字节上限（缺省 2 MiB）或时限（缺省 2000ms）⇒ `incomplete`
   并给出"已扫 N/总 M 字节"的原因；绝不把"没扫完"报成 `clean`。
4. **跨块匹配靠有界 carry**：每块与上一块末尾 ≤ `carryBytes`（缺省 8 KiB）拼接后再匹配，
   覆盖跨块的多行私钥/长 token；carry 是**显式上限**，不是"随便定的重叠长度"。
5. **结果自描述**：`ruleSetVersion`、`scannedByteCount`、`totalByteCount`、`unit:"utf8-bytes"`、
   `limitReason`、`matchedRuleIdentifiers`、`isTruncated`、`isClean` 全部随结果返回。
6. **旧接口兼容但保守**：`scanTextContent`（布尔）由四态折叠而来，
   `incomplete`/`error` 折叠为 `isSensitive:true` —— 旧调用方不会因"没扫完"被放行。

## 3. 生产调用链（源码位置）

```
SensitiveContentAccessPolicy.assertSensitiveContentReadAllowed   packages/core/src/tools/sensitive-content-access-policy.ts
├─ 路径/名称判定（既有）
└─ 内容判定
   ├─ 优先 scanTextContentDetailed → SensitiveScanResult
   │  └─ 非 clean ⇒ 抛 sensitive-content-read-denied（category = 规则/scan-incomplete/scan-error）
   └─ 兼容旧扫描器（无 detailed） ⇒ scanTextContent 布尔
DefaultDlpScanner
└─ scanSensitiveContent                                    tools/sensitive-content-scan-contract.ts
   （字节分块 + 流式解码 + 有界 carry + 字节上限 + 时限 + 规则版本）
```

## 4. 未完成（如实）

- **规则覆盖仍是最小集**（api-key/aws/private-key/github/connection-string）：
  SEC-02-02 的"版本化检测器注册表 + 阻断/掩码两套策略"、SEC-02-05 的凭据类型覆盖表**未做**；
  **裸 `sk-` 前缀**与 `infra/redaction.ts` 的规则差异**未消除**。
- **通道矩阵（SEC-02-06）未做**：哪些入口（文件/搜索/git/子进程/插件/文档转换…）最终把内容送到模型，
  没有逐通道登记与证据。
- **外发门禁（SEC-02-04）未做**：没有"来源项目/revision/目标账户/授权范围/规则版本"绑定。
- **流式输出的有界隔离缓冲未实现**：目前只有"对一段字符串扫描"，没有"边流边扫、
  首块在扫描完成前不流出"的生产路径（现有工具返回是整段文本）。
- **未验证**：没有跑过"尾部命中""跨块私钥""超限 ⇒ incomplete""非法 UTF-8 ⇒ error"
  "旧扫描器布尔兼容"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
