/**
 * 输出敏感扫描的**跨块**门禁（EXEC-01-03 剩余缺口；2026-11-14）。
 *
 * 卡内要求（§03）："敏感模式跨块匹配，**不能先发送秘密片段再补扫描**"。
 * 现状（本轮之前）：控制器只对**当前块**做 `redactSensitiveText`，
 * 一个秘密被输出缓冲切成两段时，前半段会先进入模型上下文/日志——正是卡内禁止的顺序。
 *
 * 本模块只提供**纯判定与保留策略**，不碰 I/O、不改游标：
 * - 扫描时把"上一块保留下来的尾巴"拼在新块前面 ⇒ 跨块模式也能命中；
 * - **边界保留**：末尾不足一个"最长敏感模式长度"的窗口不立即输出，等下一块到齐再判定；
 * - 明确回报扫描范围（`whole-stream` / `per-chunk`），不允许把"只扫了当前块"说成"扫过了"。
 */
import { redactSensitiveText } from "../orchestration/diagnostic-event-store.js";

/**
 * 需要保留观察的最大字符数：取常见凭据模式（`sk-…`、`AKIA…`、`ghp_…`、`BEGIN PRIVATE KEY`）
 * 的最长前缀上界再留余量，避免"尾巴留太短 ⇒ 边界仍能漏"。
 */
export const DEFAULT_BOUNDARY_CARRY_CHARACTERS = 128;

/**
 * 判断尾部是否"看起来像秘密的开头"，返回需要暂扣的字符数（0 表示不需要）。
 *
 * 判据刻意保守：宁可多扫一轮，也不把普通输出整体延迟。
 */
export const SUSPICIOUS_TAIL_PATTERNS: readonly RegExp[] = [
  /(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|xox[abposr]-|AKIA|ASIA|Bearer\\s)[A-Za-z0-9._-]*$/u,
  /[A-Za-z0-9]{8,}$/u,
];

export function findSuspiciousTailLength(text: string, carryCharacters: number): number {
  if (carryCharacters <= 0 || text === "") {
    return 0;
  }
  const windowStart = Math.max(0, text.length - carryCharacters);
  const windowText = text.slice(windowStart);
  let bestStart = -1;
  for (const pattern of SUSPICIOUS_TAIL_PATTERNS) {
    const match = pattern.exec(windowText);
    if (match !== null && match.index >= 0) {
      const absoluteStart = windowStart + match.index;
      if (bestStart === -1 || absoluteStart < bestStart) {
        bestStart = absoluteStart;
      }
    }
  }
  if (bestStart === -1) {
    return 0;
  }
  const tailText = text.slice(bestStart);
  /**
   * 尾部若是**完整**秘密（已能被脱敏规则整体命中）⇒ 不暂扣，直接交给脱敏。
   * 否则"完整秘密 + 不带尾随字符"也会被延迟一次，破坏单次读取即可用的语义。
   */
  if (redactSensitiveText(tailText) !== tailText) {
    return 0;
  }
  return text.length - bestStart;
}

export type SensitiveOutputScanScope = "per-chunk" | "whole-stream";

export interface SensitiveOutputScanResult {
  /** 可以安全返回给调用方的文本（已脱敏，且不含未判定完的边界尾）。 */
  readonly textToEmit: string;
  /** 需要与下一块拼接后再判定的尾巴。 */
  readonly carryText: string;
  /** 本次是否有内容被脱敏。 */
  readonly isRedacted: boolean;
  /** 是否因为"边界未判定完"而暂扣了内容（调用方据此解释"为什么这次少了一点"）。 */
  readonly isBoundaryWithheld: boolean;
  readonly scanScope: SensitiveOutputScanScope;
}

/**
 * 扫描一块输出，返回"可立即输出"与"必须暂扣"的两部分。
 *
 * 顺序不可交换：**先**用（上一块尾巴 + 本块）做跨块扫描，**再**切分暂扣窗口。
 */
export function scanOutputChunkAcrossBoundaries(input: {
  readonly chunkText: string;
  readonly previousCarryText: string;
  readonly carryCharacters?: number;
  readonly scanScope?: SensitiveOutputScanScope;
}): SensitiveOutputScanResult {
  const carryCharacters = Math.max(
    0,
    input.carryCharacters ?? DEFAULT_BOUNDARY_CARRY_CHARACTERS,
  );
  const scanScope = input.scanScope ?? "per-chunk";
  const combinedText = `${input.previousCarryText}${input.chunkText}`;

  if (carryCharacters === 0) {
    const redacted = redactSensitiveText(combinedText);
    return {
      textToEmit: redacted,
      carryText: "",
      isRedacted: redacted !== combinedText,
      isBoundaryWithheld: false,
      scanScope,
    };
  }

  /**
   * **只在可疑时暂扣**（2026-11-14 第二轮）：
   * 无脑暂扣末尾窗口会把普通短输出整体延迟，破坏"普通输出原样返回"的既有约束。
   * 因此先判断尾部是否可能是某个秘密的**开头**，只有可能才暂扣。
   */
  const withheldCount = findSuspiciousTailLength(combinedText, carryCharacters);
  const emittableText = combinedText.slice(0, combinedText.length - withheldCount);
  const carryText = withheldCount === 0 ? "" : combinedText.slice(combinedText.length - withheldCount);
  const redactedEmittable = redactSensitiveText(emittableText);
  /**
   * 尾巴本身也要脱敏后再保留：否则下一块把它拼回来时，秘密会以明文形式
   * 在内存里多存在一轮（虽不直接外发，但会进入诊断/日志路径的风险窗口）。
   */
  const redactedCarry = redactSensitiveText(carryText);
  return {
    textToEmit: redactedEmittable,
    carryText: redactedCarry,
    isRedacted: redactedEmittable !== emittableText || redactedCarry !== carryText,
    isBoundaryWithheld: withheldCount > 0,
    scanScope,
  };
}
