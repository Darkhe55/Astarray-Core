/**
 * 敏感扫描契约（此前 `tests/` 零引用）：四态 fail-closed。
 *
 * 核心：**`incomplete` 不是 `clean`**；按 UTF-8 字节计量；跨块匹配靠有界 carry；
 * 命中即返回 `sensitive`。所有凭据样本为人工构造假值。
 */
import { describe, expect, it } from "vitest";

import { CREDENTIAL_DETECTOR_CATALOG_VERSION } from "../../../packages/core/src/tools/credential-detector-registry.js";
import {
  DEFAULT_SENSITIVE_SCAN_LIMITS,
  SENSITIVE_SCAN_RULE_SET_VERSION,
  scanSensitiveContent,
} from "../../../packages/core/src/tools/sensitive-content-scan-contract.js";

const FAKE_TOKEN = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

describe("敏感扫描：四态", () => {
  it("① 空内容 ⇒ clean（0 字节、可继续）", () => {
    const result = scanSensitiveContent({ content: "" });
    expect(result).toMatchObject({
      outcome: "clean",
      scannedByteCount: 0,
      totalByteCount: 0,
      unit: "utf8-bytes",
      limitReason: null,
      matchedRuleIdentifiers: [],
      isTruncated: false,
      isClean: true,
    });
  });

  it("② 命中 ⇒ sensitive，并给出规则标识", () => {
    const result = scanSensitiveContent({ content: `开头 ${FAKE_TOKEN} 结尾` });
    expect(result.outcome).toBe("sensitive");
    expect(result.matchedRuleIdentifiers.length).toBeGreaterThan(0);
    expect(result.limitReason).toBeNull();
    expect(result.isClean).toBe(false);
  });

  it("③ **超出字节上限 ⇒ incomplete（不是 clean）**，并给出已扫字节数", () => {
    const result = scanSensitiveContent({
      content: "安全内容".repeat(200),
      limits: { maximumBytes: 64 },
    });
    expect(result.outcome).toBe("incomplete");
    expect(result.isTruncated).toBe(true);
    expect(result.isClean).toBe(false);
    expect(result.limitReason).toContain("字节上限");
    expect(result.scannedByteCount).toBeLessThan(result.totalByteCount);
    expect(result.scannedByteCount).toBeGreaterThan(0);
  });

  it("④ 超出时限 ⇒ incomplete，原因含时限", () => {
    let callCount = 0;
    const result = scanSensitiveContent({
      content: "安全内容".repeat(500),
      limits: { deadlineMilliseconds: 10, chunkBytes: 8 },
      nowMilliseconds: () => {
        callCount += 1;
        return callCount === 1 ? 0 : 10_000;
      },
    });
    expect(result.outcome).toBe("incomplete");
    expect(result.limitReason).toContain("时限");
    expect(result.isClean).toBe(false);
  });

  it("⑤ 预算非正整数 ⇒ 拒绝（不静默改成别的值）", () => {
    for (const limits of [
      { maximumBytes: 0 },
      { chunkBytes: -1 },
      { carryBytes: 1.5 },
      { deadlineMilliseconds: 0 },
    ]) {
      expect(() => scanSensitiveContent({ content: "x", limits })).toThrow(/必须是正整数/u);
    }
  });
});

describe("敏感扫描：计量与边界", () => {
  it("⑥ 以 UTF-8 字节计量（中文 3 字节/字，不是字符数）", () => {
    const content = "中文内容测试";
    const result = scanSensitiveContent({ content });
    expect(result.totalByteCount).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.totalByteCount).toBe(content.length * 3);
    expect(result.scannedByteCount).toBe(result.totalByteCount);
    expect(result.unit).toBe("utf8-bytes");
  });

  it("⑦ 跨块匹配：凭据被块边界切开仍能命中（有界 carry）", () => {
    /** 前缀 20 字节 + 27 字节凭据；chunk 32 字节 ⇒ 凭据跨越块边界。 */
    const content = `${"a".repeat(20)}${FAKE_TOKEN}${"b".repeat(10)}`;
    const result = scanSensitiveContent({
      content,
      limits: { chunkBytes: 32, carryBytes: 64 },
    });
    expect(result.outcome).toBe("sensitive");
    expect(result.matchedRuleIdentifiers.length).toBeGreaterThan(0);
  });

  it("⑧ 干净长文本 ⇒ clean 且扫满全部字节", () => {
    const result = scanSensitiveContent({ content: "这是一段完全普通的说明文本。".repeat(100) });
    expect(result.outcome).toBe("clean");
    expect(result.isTruncated).toBe(false);
    expect(result.scannedByteCount).toBe(result.totalByteCount);
    expect(result.matchedRuleIdentifiers).toEqual([]);
  });

  it("⑨ 规则集版本与凭据检测器目录版本一致（单一来源），默认限额为 2 MiB", () => {
    expect(SENSITIVE_SCAN_RULE_SET_VERSION).toBe(CREDENTIAL_DETECTOR_CATALOG_VERSION);
    expect(DEFAULT_SENSITIVE_SCAN_LIMITS.maximumBytes).toBe(2 * 1024 * 1024);
    for (const value of Object.values(DEFAULT_SENSITIVE_SCAN_LIMITS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
