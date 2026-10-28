/**
 * SEC-02-01（2026-10-28）：**敏感扫描结果契约**。
 *
 * 旧实现（`DefaultDlpScanner`）用 `content.slice(0, 256 * 1024)`：
 * - 常量名写 BYTES，实际是 **UTF-16 code units**（非 UTF-8 字节）；
 * - 尾部被截断仍返回 `isSensitive:false` ⇒ "没扫到" 被当成 "安全"；
 * - 没有规则版本、扫描范围、字节数、限制原因，调用方也无从得知"没扫完"。
 *
 * 本模块替换为四态契约：`clean | sensitive | incomplete | error`。
 * **只有 `clean` 可以继续**；其余三态一律按不可读处理（fail-closed）。
 *
 * 三条硬约束：
 * 1. **以 UTF-8 字节计量**：`Buffer.byteLength(content, "utf8")`，按字节切块，
 *    用流式 `TextDecoder` 解码（不会切断多字节字符）。
 * 2. **不默默截尾**：超过字节上限/时限/内存预算 ⇒ `incomplete` + 具体限制原因；
 *    绝不把"没扫完"报成 `clean`。
 * 3. **跨块匹配靠有界 carry**：每块与上一块末尾的 `maximumCarryBytes` 拼接后再匹配，
 *    保证跨块的多行私钥/长 token 不会被块边界切断；carry 有明确上限（不是随意重叠）。
 */
import { DomainError } from "../core/errors.js";
import {
  CREDENTIAL_DETECTOR_CATALOG_VERSION,
  selectDetectorRulesForModelRead,
} from "./credential-detector-registry.js";

/**
 * 规则集版本（SEC-02-02 起与凭据检测器目录版本一致；规则变动即递增）。
 */
export const SENSITIVE_SCAN_RULE_SET_VERSION = CREDENTIAL_DETECTOR_CATALOG_VERSION;

export type SensitiveScanOutcome = "clean" | "sensitive" | "incomplete" | "error";

export interface SensitiveScanRule {
  readonly identifier: string;
  readonly pattern: RegExp;
}

export interface SensitiveScanLimits {
  /** 最多扫描的 UTF-8 字节数（缺省 2 MiB）。 */
  readonly maximumBytes?: number;
  /** 扫描时限（毫秒；缺省 2000ms）。 */
  readonly deadlineMilliseconds?: number;
  /** 单块字节数（缺省 64 KiB）。 */
  readonly chunkBytes?: number;
  /** 跨块 carry 上限（缺省 8 KiB；必须 > 0 且 < chunkBytes 的两倍）。 */
  readonly carryBytes?: number;
}

export interface SensitiveScanResult {
  readonly outcome: SensitiveScanOutcome;
  readonly ruleSetVersion: number;
  /** 已扫描的 UTF-8 字节数（真实值，不是字符数）。 */
  readonly scannedByteCount: number;
  /** 内容总 UTF-8 字节数。 */
  readonly totalByteCount: number;
  readonly unit: "utf8-bytes";
  /** `incomplete`/`error` 时的具体原因；`clean`/`sensitive` 为 null。 */
  readonly limitReason: string | null;
  /** 命中的规则标识（`sensitive` 时非空）。 */
  readonly matchedRuleIdentifiers: readonly string[];
  /** 是否因预算/时限提前结束（等价于 outcome === "incomplete"）。 */
  readonly isTruncated: boolean;
  /** 旧调用方唯一可继续的判据：`outcome === "clean"`。 */
  readonly isClean: boolean;
}

export const DEFAULT_SENSITIVE_SCAN_LIMITS: Required<SensitiveScanLimits> = {
  maximumBytes: 2 * 1024 * 1024,
  deadlineMilliseconds: 2_000,
  chunkBytes: 64 * 1024,
  carryBytes: 8 * 1024,
};

/**
 * 默认本地检测规则：**直接取自凭据检测器注册表的"阻断模型读取"视图**。
 *
 * 单一来源：规则只在 `credential-detector-registry.ts` 定义一次；
 * 这里不再维护第二份列表（旧实现曾在 DLP 与 redaction 各维护一套、覆盖不一致）。
 * 更完整的凭据类型覆盖与日志掩码策略见 SEC-02-02/05。
 */
export const DEFAULT_SENSITIVE_SCAN_RULES: readonly SensitiveScanRule[] =
  selectDetectorRulesForModelRead();

export interface ScanSensitiveContentInput {
  readonly content: string;
  readonly rules?: readonly SensitiveScanRule[];
  readonly limits?: SensitiveScanLimits;
  /** 时钟注入（测试/确定性用；缺省 `Date.now`）。 */
  readonly nowMilliseconds?: () => number;
}

/**
 * 按 UTF-8 字节分块扫描内容。
 *
 * 失败方向刻意保守：任何"没扫完/解不了/超时"都返回 `incomplete` 或 `error`，
 * 从不返回 `clean`；命中即返回 `sensitive`（不继续扫剩余内容，避免不必要开销）。
 */
export function scanSensitiveContent(
  input: ScanSensitiveContentInput,
): SensitiveScanResult {
  const limits: Required<SensitiveScanLimits> = {
    ...DEFAULT_SENSITIVE_SCAN_LIMITS,
    ...input.limits,
  };
  if (
    !Number.isInteger(limits.maximumBytes) ||
    !Number.isInteger(limits.deadlineMilliseconds) ||
    !Number.isInteger(limits.chunkBytes) ||
    !Number.isInteger(limits.carryBytes) ||
    limits.maximumBytes <= 0 ||
    limits.deadlineMilliseconds <= 0 ||
    limits.chunkBytes <= 0 ||
    limits.carryBytes <= 0
  ) {
    throw new DomainError("invalid-task-chain", "敏感扫描预算必须是正整数（字节/毫秒）。");
  }
  const rules = input.rules ?? DEFAULT_SENSITIVE_SCAN_RULES;
  const nowMilliseconds = input.nowMilliseconds ?? (() => Date.now());
  const startedAtMilliseconds = nowMilliseconds();
  const contentBuffer = Buffer.from(input.content, "utf8");
  const totalByteCount = contentBuffer.byteLength;

  const buildResult = (
    outcome: SensitiveScanOutcome,
    scannedByteCount: number,
    limitReason: string | null,
    matchedRuleIdentifiers: readonly string[],
  ): SensitiveScanResult => ({
    outcome,
    ruleSetVersion: SENSITIVE_SCAN_RULE_SET_VERSION,
    scannedByteCount,
    totalByteCount,
    unit: "utf8-bytes",
    limitReason,
    matchedRuleIdentifiers,
    isTruncated: outcome === "incomplete",
    isClean: outcome === "clean",
  });

  if (totalByteCount === 0) {
    return buildResult("clean", 0, null, []);
  }

  /** 流式解码器：`fatal` 让"解码失败"变成 `error`，而不是静默替换成 U+FFFD。 */
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder("utf-8", { fatal: true });
  } catch (error) {
    return buildResult("error", 0, `解码器不可用: ${(error as Error).message}`, []);
  }

  const carryBytes = Math.min(limits.carryBytes, limits.chunkBytes * 2);
  let carryText = "";
  let offsetBytes = 0;
  while (offsetBytes < totalByteCount) {
    if (nowMilliseconds() - startedAtMilliseconds > limits.deadlineMilliseconds) {
      return buildResult(
        "incomplete",
        offsetBytes,
        `超出扫描时限 ${limits.deadlineMilliseconds}ms（已扫 ${offsetBytes}/${totalByteCount} 字节）`,
        [],
      );
    }
    if (offsetBytes >= limits.maximumBytes) {
      return buildResult(
        "incomplete",
        offsetBytes,
        `超出扫描字节上限 ${limits.maximumBytes}（已扫 ${offsetBytes}/${totalByteCount} 字节）`,
        [],
      );
    }
    const remainingBudgetBytes = Math.min(
      limits.chunkBytes,
      limits.maximumBytes - offsetBytes,
      totalByteCount - offsetBytes,
    );
    const chunk = contentBuffer.subarray(offsetBytes, offsetBytes + remainingBudgetBytes);
    let decodedChunk: string;
    try {
      decodedChunk = decoder.decode(chunk, { stream: true });
    } catch (error) {
      return buildResult(
        "error",
        offsetBytes,
        `UTF-8 解码失败（offset ${offsetBytes}）: ${(error as Error).message}`,
        [],
      );
    }
    offsetBytes += chunk.byteLength;
    const windowText = carryText + decodedChunk;
    const matchedRuleIdentifiers = rules
      .filter((rule) => rule.pattern.test(windowText))
      .map((rule) => rule.identifier);
    if (matchedRuleIdentifiers.length > 0) {
      return buildResult("sensitive", offsetBytes, null, matchedRuleIdentifiers);
    }
    /**
     * carry 只保留**有界尾部**：足够覆盖跨块的多行私钥/长 token，
     * 又不会把整段内容复制进下一窗口（不是"随便定一个重叠长度"）。
     */
    carryText = takeTrailingTextWithinBytes(windowText, carryBytes);
  }
  try {
    decoder.decode();
  } catch (error) {
    return buildResult(
      "error",
      offsetBytes,
      `UTF-8 收尾解码失败: ${(error as Error).message}`,
      [],
    );
  }
  return buildResult("clean", offsetBytes, null, []);
}

/** 取字符串末尾不超过 `maximumBytes` 个 UTF-8 字节的片段（不切断多字节字符）。 */
function takeTrailingTextWithinBytes(text: string, maximumBytes: number): string {
  if (text === "") {
    return "";
  }
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maximumBytes) {
    return text;
  }
  let trailingText = "";
  let consumedBytes = 0;
  const codePoints = [...text];
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index] as string;
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (consumedBytes + codePointBytes > maximumBytes) {
      break;
    }
    trailingText = codePoint + trailingText;
    consumedBytes += codePointBytes;
  }
  return trailingText;
}
