# ADR-0107 block 模式的误报率探针（SEC-02 / R19）

- 状态：脚本已交付（**未执行**；仅语法检查）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R19
- 相关：ADR-0080（出口扫描默认 record）、ADR-0067（四态扫描）

## 1. 背景

模型请求出口扫描（ADR-0080）默认 `record` 而不是 `block`，理由是"误拦会让请求直接失败，
误报率未知"。但没有**可重复的测量方式**，这个理由就一直只是判断而非证据。

## 2. 交付

1. `scripts/manual/egress-false-positive-probe.mjs`：
   - **normal 样本 8 条**（中文/英文散文、代码、配置 JSON、`.invalid` URL、SQL、提交信息）——
     期望 `clean`；命中即**误报**；
   - **fake-credential 样本 6 条**（Anthropic / OpenAI-compatible / GitHub / AWS / PEM / 连接串，
     全部 `FAKE` 前缀或 `.invalid` 域名）—— 期望 `sensitive` 且命中预期规则；
   - 输出逐样本结论 + 汇总（`falsePositives` / `missesOrOtherRules`）；异常时退出 1。
2. 公共 SDK 增补导出：`scanSensitiveContent`、`SENSITIVE_SCAN_RULE_SET_VERSION`、
   `DEFAULT_SENSITIVE_SCAN_RULES`、`DEFAULT_SENSITIVE_SCAN_LIMITS` 及类型
   （纯函数；不联网、不写盘）。

## 3. 使用方式与边界

```powershell
cd astarray
npm run build
node scripts/manual/egress-false-positive-probe.mjs
```

**边界（必须说清）**：
- 这是**样本级探针**，不是产品级误报率；8 + 6 条样本**不足以**支撑"默认开启 block"的结论；
- 样本是我人工构造的，**不代表真实用户内容分布**；
- 探针只测**规则命中**，不测"命中后是否阻断"（阻断行为在 runtime/bridge 内）；
- 未运行 ⇒ 没有任何实测数字。

## 4. 未完成（如实）

- **未执行**（仅 `node --check` 语法通过）；
- 样本量小、无真实语料；
- 没有 CI/自动化统计；
- 没有与 MCP 结果扫描（ADR-0105）共用样本的对照。

## 5. 验证状态

**未运行**；`node --check` exit 0（语法）；`typecheck`/`build` 通过（SDK 导出为纯函数）。

## 6. 执行记录（2026-10-29，窗口后补）

首次执行 **exit 1**：8 条 normal 全 clean（0 误报），6 条假凭据 **5 命中 / 1 MISS**
（`fake-aws`）。定位为**样本长度写错**（规则要求 `AKIA` 后 16 位，样本只有 14 位），
修正样本后复跑 **exit 0**，6/6 命中、0 误报。详见
[SCRIPT_RUN_EVIDENCE_2026-10-29](../reports/SCRIPT_RUN_EVIDENCE_2026-10-29.md)。
