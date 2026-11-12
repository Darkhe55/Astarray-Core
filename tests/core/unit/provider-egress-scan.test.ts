/**
 * 模型请求出口扫描（此前 `tests/` 零引用）：三档行为，**缺省不拦截**。
 *
 * 核心语义：`off` 不扫；`record` 命中只记录**仍然发送**；`block` 命中抛错**不发送**；
 * `incomplete` 在 block 模式下同样阻断（没扫完不能发）；环形缓冲有界且保留最新。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  MAXIMUM_PROVIDER_EGRESS_SCAN_RECORDS,
  applyProviderEgressScan,
  clearProviderEgressScanRecords,
  readProviderEgressScanRecords,
} from "../../../packages/core/src/runtime/provider-egress-scan.js";

const FAKE_TOKEN = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
const CLEAN_BODY = JSON.stringify({ messages: [{ content: "请总结这份文档" }] });
const SENSITIVE_BODY = JSON.stringify({ messages: [{ content: `配置：${FAKE_TOKEN}` }] });

afterEach(() => {
  clearProviderEgressScanRecords();
});

describe("出口扫描三档", () => {
  it("① off ⇒ 不扫描、不记录、放行", () => {
    expect(
      applyProviderEgressScan({
        providerIdentifier: "provider-1",
        requestBodyJson: SENSITIVE_BODY,
        options: { mode: "off" },
      }),
    ).toBeNull();
    expect(readProviderEgressScanRecords()).toEqual([]);
  });

  it("② record 模式 + 干净请求体 ⇒ 放行且不记录", () => {
    expect(
      applyProviderEgressScan({
        providerIdentifier: "provider-1",
        requestBodyJson: CLEAN_BODY,
        options: { mode: "record" },
      }),
    ).toBeNull();
    expect(readProviderEgressScanRecords()).toEqual([]);
  });

  it("③ record 模式 + 命中 ⇒ 记录但**仍然发送**（不抛错）", () => {
    const record = applyProviderEgressScan({
      providerIdentifier: "provider-1",
      requestBodyJson: SENSITIVE_BODY,
      options: { mode: "record", nowIso: () => "2026-11-13T00:00:00.000Z" },
    });
    expect(record).not.toBeNull();
    expect(record?.didBlock).toBe(false);
    expect(record?.providerIdentifier).toBe("provider-1");
    expect(record?.recordedAtIso).toBe("2026-11-13T00:00:00.000Z");
    expect(record?.matchedRuleIdentifiers.length).toBeGreaterThan(0);
    expect(record?.requestBodyByteCount).toBe(Buffer.byteLength(SENSITIVE_BODY, "utf8"));
    expect(readProviderEgressScanRecords()).toHaveLength(1);
  });

  it("④ block 模式 + 命中 ⇒ 抛错（不发送），且记录已落审计", () => {
    expect(() =>
      applyProviderEgressScan({
        providerIdentifier: "provider-1",
        requestBodyJson: SENSITIVE_BODY,
        options: { mode: "block" },
      }),
    ).toThrow(/拒绝发送模型请求/u);

    const records = readProviderEgressScanRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.didBlock).toBe(true);
  });

  it("⑤ block 模式 + 没扫完 ⇒ 同样阻断（没扫完不能发）", () => {
    const hugeBody = "x".repeat(2_200_000);
    expect(() =>
      applyProviderEgressScan({
        providerIdentifier: "provider-1",
        requestBodyJson: hugeBody,
        options: { mode: "block" },
      }),
    ).toThrow(/incomplete|拒绝发送/u);
    expect(readProviderEgressScanRecords()[0]?.outcome).toBe("incomplete");
  });

  it("⑥ 环形缓冲有界且保留最新", () => {
    for (let index = 0; index < MAXIMUM_PROVIDER_EGRESS_SCAN_RECORDS + 5; index += 1) {
      applyProviderEgressScan({
        providerIdentifier: `provider-${String(index)}`,
        requestBodyJson: SENSITIVE_BODY,
        options: { mode: "record" },
      });
    }
    const records = readProviderEgressScanRecords();
    expect(records).toHaveLength(MAXIMUM_PROVIDER_EGRESS_SCAN_RECORDS);
    expect(records[records.length - 1]?.providerIdentifier).toBe(
      `provider-${String(MAXIMUM_PROVIDER_EGRESS_SCAN_RECORDS + 4)}`,
    );
  });

  it("⑦ 审计端口收到同一条记录", () => {
    const auditRecords: unknown[] = [];
    applyProviderEgressScan({
      providerIdentifier: "provider-audit",
      requestBodyJson: SENSITIVE_BODY,
      options: { mode: "record", auditSink: (record) => auditRecords.push(record) },
    });
    expect(auditRecords).toHaveLength(1);
    expect((auditRecords[0] as { providerIdentifier: string }).providerIdentifier).toBe(
      "provider-audit",
    );
  });

  it("⑧ 记录不含正文（只有计数与规则标识）", () => {
    applyProviderEgressScan({
      providerIdentifier: "provider-1",
      requestBodyJson: SENSITIVE_BODY,
      options: { mode: "record" },
    });
    const serialized = JSON.stringify(readProviderEgressScanRecords());
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("配置：");
  });
});
