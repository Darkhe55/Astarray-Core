#!/usr/bin/env node
/**
 * R19（2026-10-29）：**出口/结果扫描的误报率探针**。
 *
 * ⚠️ 本脚本**从未运行**（窗口口径：不运行测试/验收）。它的用途是：在用户授权后，
 * 用**固定的样本集**回答"如果默认把扫描改成 block，会不会误伤正常内容"。
 *
 * 样本分两类：
 * - normal：正常中文/英文/代码文本（**不应命中**）；
 * - fake-credential：人工构造的假凭据（**应当命中**；都是 `FAKE` 前缀或 `.invalid` 域名）。
 *
 * 输出：逐样本结论 + 汇总（normal 命中数 = 误报数；fake 命中数 = 真阳数）。
 * 退出码：0 全部符合预期；1 存在误报或漏报（便于人工复核）。
 *
 * 用法（在 `astarray/` 下，先 `npm run build`）：
 *   node scripts/manual/egress-false-positive-probe.mjs
 */
import { scanSensitiveContent } from "../../dist/public-sdk.js";

const normalSamples = [
  {
    identifier: "normal-zh-prose",
    text: "这次修改把任务序列的校验提前到写入之前，并补了一条回滚说明。",
  },
  {
    identifier: "normal-en-prose",
    text: "The scheduler waits for the current group to finish before inserting the next task.",
  },
  {
    identifier: "normal-code",
    text: "const options = { tokenBudget: 4096, maxRetries: 3 };\nfunction run() { return 42; }",
  },
  {
    identifier: "normal-env-doc",
    text: "Set the environment variable API_KEY in your shell before running the CLI.",
  },
  {
    identifier: "normal-json-config",
    text: '{"model": "example-model", "temperature": 0.2, "max_tokens": 1024}',
  },
  {
    identifier: "normal-url",
    text: "See https://example.invalid/docs/getting-started for the full guide.",
  },
  {
    identifier: "normal-sql",
    text: "SELECT id, title FROM tasks WHERE status = 'done' ORDER BY updated_at DESC;",
  },
  {
    identifier: "normal-commit-message",
    text: "fix(core): reconcile goal state before resuming a mission",
  },
];

const fakeCredentialSamples = [
  {
    identifier: "fake-anthropic",
    text: "ANTHROPIC_API_KEY=sk-ant-FAKE0000000000000000000000",
    expectedRulePrefix: "vendor:anthropic-api-key",
  },
  {
    identifier: "fake-openai-style",
    text: "OPENAI_API_KEY=sk-FAKE0000000000000000",
    expectedRulePrefix: "vendor:openai-style-api-key",
  },
  {
    identifier: "fake-github",
    text: "token=ghp_FAKE0000000000000000",
    expectedRulePrefix: "vcs:github-token-classic",
  },
  {
    identifier: "fake-aws",
    text: "aws_access_key_id = AKIAFAKE0000000000",
    expectedRulePrefix: "cloud:aws-access-key-id",
  },
  {
    identifier: "fake-private-key",
    text: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nFAKE0000000000000000\n-----END ENCRYPTED PRIVATE KEY-----",
    expectedRulePrefix: "key:pem-private-key",
  },
  {
    identifier: "fake-connection-string",
    text: "postgres://fake_user:fake_password@db.example.invalid:5432/app",
    expectedRulePrefix: "db:connection-string-password",
  },
];

let falsePositiveCount = 0;
let missedCredentialCount = 0;

process.stdout.write("== normal samples (should be clean) ==\n");
for (const sample of normalSamples) {
  const result = scanSensitiveContent({ content: sample.text });
  const flagged = result.outcome !== "clean";
  if (flagged) {
    falsePositiveCount += 1;
  }
  process.stdout.write(
    `${flagged ? "FLAGGED" : "clean  "} ${sample.identifier} outcome=${result.outcome}` +
      (result.matchedRuleIdentifiers.length > 0
        ? ` rules=${result.matchedRuleIdentifiers.join(",")}`
        : "") +
      "\n",
  );
}

process.stdout.write("\n== fake credential samples (should be sensitive) ==\n");
for (const sample of fakeCredentialSamples) {
  const result = scanSensitiveContent({ content: sample.text });
  const hit = result.outcome === "sensitive";
  const matchedExpected =
    hit &&
    result.matchedRuleIdentifiers.some((ruleIdentifier) =>
      ruleIdentifier.startsWith(sample.expectedRulePrefix),
    );
  if (!matchedExpected) {
    missedCredentialCount += 1;
  }
  process.stdout.write(
    `${matchedExpected ? "hit    " : "MISS/OTHER"} ${sample.identifier} outcome=${result.outcome} rules=${
      result.matchedRuleIdentifiers.join(",") || "-"
    }\n`,
  );
}

process.stdout.write(
  `\nsummary: normalSamples=${normalSamples.length} falsePositives=${falsePositiveCount} ` +
    `fakeCredentialSamples=${fakeCredentialSamples.length} missesOrOtherRules=${missedCredentialCount}\n`,
);
process.stdout.write(
  "note: 这是样本级探针，不是产品级误报率；样本很少，结果只能作为是否开启 block 的参考。\n",
);

process.exitCode = falsePositiveCount === 0 && missedCredentialCount === 0 ? 0 : 1;
