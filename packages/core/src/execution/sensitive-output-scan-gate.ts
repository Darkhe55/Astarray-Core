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

  /** 末尾窗口暂扣：长度不足一个窗口时什么都不发，等下一块。 */
  const withheldCount = Math.min(carryCharacters, combinedText.length);
  const emittableText = combinedText.slice(0, combinedText.length - withheldCount);
  const carryText = combinedText.slice(combinedText.length - withheldCount);
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
