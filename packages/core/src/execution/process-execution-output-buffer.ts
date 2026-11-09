/**
 * EXEC-01-03（2026-11-09）：**执行输出缓冲**（字节游标、UTF-8 跨块、ANSI 清理、截断标记）。
 *
 * 三条硬要求（卡内 §03）：
 * 1. stdout/stderr **分流**，读取用**字节游标**且单次有界（默认 32 KiB，最大 128 KiB）；
 * 2. UTF-8 跨块不得产生替换字符 —— 追加时用流式解码器挂起半个码点，
 *    读取时也不得把码点切成两半（宁可少给几个字节，下次从游标继续）；
 * 3. 单流存储上限（默认 8 MiB）超限时**标记截断**并停止追加，
 *    但截断**不等于**执行成功（调用方不得据此判成功）。
 */

/** 去掉 ANSI/终端控制序列（CSI/OSC/单字符 ESC）。 */
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/gu;

export function stripAnsiControlSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

export interface ProcessOutputStreamReadResult {
  readonly text: string;
  readonly nextCursorBytes: number;
  readonly isTruncated: boolean;
  readonly hasMoreBytes: boolean;
}

export class ProcessOutputStreamBuffer {
  private readonly decoder: TextDecoder;
  private accumulatedText = "";
  private accumulatedBytes = 0;
  private isStorageLimitReached = false;

  constructor(private readonly storageLimitBytes: number) {
    /** 流式解码：不完整的 UTF-8 序列由解码器挂起，不在块边界产生 U+FFFD。 */
    this.decoder = new TextDecoder("utf-8", { fatal: false });
  }

  /** 追加一段原始字节；超过存储上限后停止追加并标记截断。 */
  appendBytes(chunk: Uint8Array): void {
    if (this.isStorageLimitReached) return;
    const decoded = this.decoder.decode(chunk, { stream: true });
    if (decoded === "") return;
    const sanitized = stripAnsiControlSequences(decoded);
    if (sanitized === "") return;
    const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");
    if (this.accumulatedBytes + sanitizedBytes > this.storageLimitBytes) {
      /** 只保留仍在上限内的完整前缀，随后停止追加（游标保持稳定）。 */
      const remainingBytes = this.storageLimitBytes - this.accumulatedBytes;
      if (remainingBytes > 0) {
        const partialText = this.takeCompleteUtf8Prefix(sanitized, remainingBytes);
        this.accumulatedText += partialText;
        this.accumulatedBytes += Buffer.byteLength(partialText, "utf8");
      }
      this.isStorageLimitReached = true;
      return;
    }
    this.accumulatedText += sanitized;
    this.accumulatedBytes += sanitizedBytes;
  }

  /** 冲刷解码器挂起的尾部（进程结束时调用；半码点会变成替换字符，属预期）。 */
  flushDecoder(): void {
    if (this.isStorageLimitReached) return;
    const decoded = this.decoder.decode();
    if (decoded === "") return;
    const sanitized = stripAnsiControlSequences(decoded);
    if (sanitized === "") return;
    const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");
    if (this.accumulatedBytes + sanitizedBytes > this.storageLimitBytes) {
      this.isStorageLimitReached = true;
      return;
    }
    this.accumulatedText += sanitized;
    this.accumulatedBytes += sanitizedBytes;
  }

  /** 按字节游标读取（有界）；不切断 UTF-8 码点。 */
  read(input: {
    readonly fromCursorBytes: number;
    readonly maximumBytes: number;
  }): ProcessOutputStreamReadResult {
    const allBytes = Buffer.from(this.accumulatedText, "utf8");
    const start = Math.min(Math.max(0, input.fromCursorBytes), allBytes.length);
    const end = Math.min(start + Math.max(1, input.maximumBytes), allBytes.length);
    const slice = allBytes.subarray(start, end);
    const safeLength = this.completeUtf8PrefixLength(slice);
    const text = safeLength === 0 ? "" : slice.subarray(0, safeLength).toString("utf8");
    const nextCursorBytes = start + safeLength;
    return {
      text,
      nextCursorBytes,
      isTruncated: this.isStorageLimitReached,
      hasMoreBytes: nextCursorBytes < allBytes.length || this.isStorageLimitReached,
    };
  }

  /** 全量文本（仅供敏感内容扫描；**不得**直接回给模型）。 */
  readAllTextForScanning(): string {
    return this.accumulatedText;
  }

  getTotalBytes(): number {
    return this.accumulatedBytes;
  }

  getIsStorageLimitReached(): boolean {
    return this.isStorageLimitReached;
  }

  /** 取不超过上限的完整 UTF-8 前缀。 */
  private takeCompleteUtf8Prefix(text: string, maximumBytes: number): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maximumBytes) return text;
    const safeLength = this.completeUtf8PrefixLength(bytes.subarray(0, maximumBytes));
    return bytes.subarray(0, safeLength).toString("utf8");
  }

  /** 返回 `bytes` 中"完整 UTF-8 序列"的长度（末尾不完整序列被排除）。 */
  private completeUtf8PrefixLength(bytes: Uint8Array): number {
    const length = bytes.length;
    if (length === 0) return 0;
    let continuationBytesExpected = 0;
    let sequenceStartIndex = -1;
    for (let index = length - 1; index >= 0 && index >= length - 4; index -= 1) {
      const byte = bytes[index] ?? 0;
      if ((byte & 0b1100_0000) === 0b1000_0000) {
        /** 续字节：继续往前找起始字节。 */
        continue;
      }
      sequenceStartIndex = index;
      if ((byte & 0b1000_0000) === 0) {
        continuationBytesExpected = 0;
      } else if ((byte & 0b1110_0000) === 0b1100_0000) {
        continuationBytesExpected = 1;
      } else if ((byte & 0b1111_0000) === 0b1110_0000) {
        continuationBytesExpected = 2;
      } else if ((byte & 0b1111_1000) === 0b1111_0000) {
        continuationBytesExpected = 3;
      } else {
        continuationBytesExpected = 0;
      }
      break;
    }
    if (sequenceStartIndex < 0) {
      /** 全是续字节：整段都不完整。 */
      return 0;
    }
    const actualContinuationBytes = length - sequenceStartIndex - 1;
    if (continuationBytesExpected > actualContinuationBytes) {
      return sequenceStartIndex;
    }
    return length;
  }
}
