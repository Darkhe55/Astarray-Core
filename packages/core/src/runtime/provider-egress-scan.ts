/**
 * 接线缺口第 ③ 项（2026-10-28）：**模型请求最终出口的敏感内容扫描**。
 *
 * 背景（SEC-02-06 通道 13）：仓库里有文件/搜索/Git 等入口的 DLP，但**没有任何**
 * 在"请求体真正发给模型 provider 之前"的检查 —— 也就是说，摘要、记忆、MCP 结果、
 * 子进程输出等拼进提示词后，最后一道闸不存在。
 *
 * 本模块提供**三档**行为（刻意默认保守但**不拦截**）：
 * - `off`：完全不扫描（显式关闭）；
 * - `record`：**缺省**。扫描请求体，命中即记录（环形缓冲 + 可注入审计端口），
 *   **仍然发送** —— 因为提示词里出现 `token=`/`password=` 这类字符串可能只是正常文本，
 *   误拦会让模型请求直接失败；是否拦需要实测误报率后由用户决定；
 * - `block`：命中即抛 `sensitive-content-read-denied`，**不发送**。
 *
 * 扫描范围只含**请求体**（消息内容），**不含请求头** —— 头部携带 `Authorization`/`x-api-key`
 * 是协议要求，扫描头部只会把每次正常请求都判成敏感（这一点必须说清）。
 */
import { DomainError } from "../core/errors.js";
import {
  scanSensitiveContent,
} from "../tools/sensitive-content-scan-contract.js";
import type { SensitiveScanResult } from "../tools/sensitive-content-scan-contract.js";

export type ProviderEgressScanMode = "off" | "record" | "block";

export interface ProviderEgressScanRecord {
  readonly providerIdentifier: string;
  readonly recordedAtIso: string;
  readonly outcome: SensitiveScanResult["outcome"];
  readonly ruleSetVersion: number;
  readonly matchedRuleIdentifiers: readonly string[];
  readonly limitReason: string | null;
  readonly requestBodyByteCount: number;
  readonly scannedByteCount: number;
  readonly didBlock: boolean;
}

export interface ProviderEgressScanOptions {
  readonly mode: ProviderEgressScanMode;
  /** 注入的审计端口（缺省只进环形缓冲）。 */
  readonly auditSink?: (record: ProviderEgressScanRecord) => void;
  readonly nowIso?: () => string;
}

/** 环形缓冲上限（只保留最近若干条，避免无界内存）。 */
export const MAXIMUM_PROVIDER_EGRESS_SCAN_RECORDS = 100;

const providerEgressScanRecords: ProviderEgressScanRecord[] = [];

/** 读取最近的扫描记录（只读副本；用于诊断与后续 UI）。 */
export function readProviderEgressScanRecords(): readonly ProviderEgressScanRecord[] {
  return [...providerEgressScanRecords];
}

/** 清空环形缓冲（便于测试/诊断；不影响任何真实请求）。 */
export function clearProviderEgressScanRecords(): void {
  providerEgressScanRecords.length = 0;
}

/**
 * 在发送前扫描请求体。
 *
 * 返回 `null` 表示放行；`block` 模式命中时抛错（**不发送**）。
 */
export function applyProviderEgressScan(input: {
  readonly providerIdentifier: string;
  readonly requestBodyJson: string;
  readonly options: ProviderEgressScanOptions;
}): ProviderEgressScanRecord | null {
  const mode = input.options.mode;
  if (mode === "off") {
    return null;
  }
  const scanResult = scanSensitiveContent({ content: input.requestBodyJson });
  if (scanResult.outcome === "clean") {
    return null;
  }
  const record: ProviderEgressScanRecord = {
    providerIdentifier: input.providerIdentifier,
    recordedAtIso: input.options.nowIso?.() ?? new Date().toISOString(),
    outcome: scanResult.outcome,
    ruleSetVersion: scanResult.ruleSetVersion,
    matchedRuleIdentifiers: [...scanResult.matchedRuleIdentifiers],
    limitReason: scanResult.limitReason,
    requestBodyByteCount: scanResult.totalByteCount,
    scannedByteCount: scanResult.scannedByteCount,
    didBlock: mode === "block",
  };
  providerEgressScanRecords.push(record);
  if (providerEgressScanRecords.length > MAXIMUM_PROVIDER_EGRESS_SCAN_RECORDS) {
    providerEgressScanRecords.shift();
  }
  input.options.auditSink?.(record);
  if (mode === "block") {
    const reason =
      scanResult.outcome === "sensitive"
        ? `命中规则 ${scanResult.matchedRuleIdentifiers.join(", ")}`
        : `${scanResult.outcome}: ${scanResult.limitReason ?? "未知原因"}`;
    throw new DomainError(
      "sensitive-content-read-denied",
      `拒绝发送模型请求（出口扫描，规则版本 ${scanResult.ruleSetVersion}）：${reason}。` +
        "（如需放行请由用户显式切换为 record/off，不能由模型决定。）",
    );
  }
  return record;
}
