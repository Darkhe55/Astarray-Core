/**
 * SEC-02-01（2026-11-23）：四态扫描判定分支的反例。
 *
 * 覆盖 `assertSensitiveContentReadAllowed` 的放行/拒绝分支：
 * - 四态扫描器：clean 放行；sensitive/incomplete/error 一律拒绝（"没扫完"不是"安全"）；
 * - 旧布尔扫描器：命中即拒、未命中放行；
 * - 目录过滤与构建拒绝类别。
 */
import { describe, expect, it } from "vitest";

import {
  SensitiveContentAccessPolicy,
  type SensitiveContentDlpScanner,
} from "../../../packages/core/src/tools/sensitive-content-access-policy.js";

function detailedScanner(
  outcome: "clean" | "sensitive" | "incomplete" | "error",
  matchedRuleIdentifiers: string[] = [],
): SensitiveContentDlpScanner {
  return {
    scanTextContent: async () => ({ isSensitive: false }),
    scanTextContentDetailed: async () => ({
      outcome,
      matchedRuleIdentifiers,
      scannedBytes: 1,
      isTruncated: false,
    }),
  } as never;
}

const input = { canonicalPath: "/tmp/notes.txt", content: "hello" };

describe("SEC-02-01：四态扫描判定", () => {
  it("① clean ⇒ 放行", async () => {
    const policy = new SensitiveContentAccessPolicy({ dlpScanner: detailedScanner("clean") });
    await expect(policy.assertSensitiveContentReadAllowed(input)).resolves.toBeUndefined();
  });

  it("② sensitive ⇒ 拒绝，类别取首个命中规则", async () => {
    const policy = new SensitiveContentAccessPolicy({
      dlpScanner: detailedScanner("sensitive", ["aws-access-key"]),
    });
    await expect(policy.assertSensitiveContentReadAllowed(input)).rejects.toMatchObject({
      errorCode: "sensitive-content-read-denied",
      message: expect.stringContaining("aws-access-key"),
    });
  });

  it("③ incomplete ⇒ 拒绝（没扫完不算安全）", async () => {
    const policy = new SensitiveContentAccessPolicy({ dlpScanner: detailedScanner("incomplete") });
    await expect(policy.assertSensitiveContentReadAllowed(input)).rejects.toMatchObject({
      message: expect.stringContaining("dlp:scan-incomplete"),
    });
  });

  it("④ error ⇒ 拒绝并标明扫描错误", async () => {
    const policy = new SensitiveContentAccessPolicy({ dlpScanner: detailedScanner("error") });
    await expect(policy.assertSensitiveContentReadAllowed(input)).rejects.toMatchObject({
      message: expect.stringContaining("dlp:scan-error"),
    });
  });

  it("⑤ 旧布尔扫描器：命中即拒、未命中放行", async () => {
    const sensitive = new SensitiveContentAccessPolicy({
      dlpScanner: { scanTextContent: async () => ({ isSensitive: true }) } as never,
    });
    await expect(sensitive.assertSensitiveContentReadAllowed(input)).rejects.toMatchObject({
      message: expect.stringContaining("dlp:unknown"),
    });
    const clean = new SensitiveContentAccessPolicy({
      dlpScanner: { scanTextContent: async () => ({ isSensitive: false }) } as never,
    });
    await expect(clean.assertSensitiveContentReadAllowed(input)).resolves.toBeUndefined();
  });

  it("⑥ 无正文 ⇒ 只做路径判定（不调用扫描器）", async () => {
    let scanCalls = 0;
    const scanner = {
      scanTextContent: async () => {
        scanCalls += 1;
        return { isSensitive: false };
      },
      scanTextContentDetailed: async () => {
        scanCalls += 1;
        return { outcome: "clean", matchedRuleIdentifiers: [] };
      },
    } as never;
    const policy = new SensitiveContentAccessPolicy({ dlpScanner: scanner });
    await policy.assertSensitiveContentReadAllowed({ canonicalPath: "/tmp/notes.txt" });
    expect(scanCalls).toBe(0);
  });

  it("⑦ 目录过滤：敏感名称被过滤，普通名称保留", () => {
    const policy = new SensitiveContentAccessPolicy();
    const filtered = policy.filterSensitiveDirectoryEntries("/project", [
      ".env",
      "notes.txt",
      "id_rsa",
      "README.md",
    ]);
    expect(filtered).toContain("notes.txt");
    expect(filtered).toContain("README.md");
    expect(filtered).not.toContain(".env");
    expect(filtered).not.toContain("id_rsa");
  });
});
