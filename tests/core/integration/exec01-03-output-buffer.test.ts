/**
 * EXEC-01-03（2026-11-09）：输出缓冲的**反例优先**验证。
 *
 * 重点不是"能读输出"，而是：UTF-8 跨块不出替换字符、ANSI 被清掉、
 * 超限必须标记截断且停止追加、读取不得把码点切成两半。
 */
import { describe, expect, it } from "vitest";

import {
  ProcessOutputStreamBuffer,
  stripAnsiControlSequences,
} from "../../../packages/core/src/execution/process-execution-output-buffer.js";

describe("EXEC-01-03 输出缓冲：UTF-8 跨块", () => {
  it("多字节字符被拆成两块追加 ⇒ 不产生替换字符", () => {
    const buffer = new ProcessOutputStreamBuffer(1024 * 1024);
    /** "中" 的 UTF-8 是 E4 B8 AD：把三字节拆到两次 append。 */
    buffer.appendBytes(Buffer.from([0xe4, 0xb8]));
    buffer.appendBytes(Buffer.from([0xad]));
    buffer.flushDecoder();
    const read = buffer.read({ fromCursorBytes: 0, maximumBytes: 1024 });
    expect(read.text).toBe("中");
    expect(read.text).not.toContain("\uFFFD");
  });

  it("读取时按字节上限截断也不切断码点", () => {
    const buffer = new ProcessOutputStreamBuffer(1024 * 1024);
    buffer.appendBytes(Buffer.from("中文字", "utf8"));
    /** 上限 4 字节：3 字节的"中"完整，第 4 字节是"文"的首字节 ⇒ 只给"中"。 */
    const first = buffer.read({ fromCursorBytes: 0, maximumBytes: 4 });
    expect(first.text).toBe("中");
    expect(first.nextCursorBytes).toBe(3);
    const second = buffer.read({ fromCursorBytes: first.nextCursorBytes, maximumBytes: 4 });
    expect(second.text).toBe("文");
  });

  it("游标推进后可继续读到剩余内容", () => {
    const buffer = new ProcessOutputStreamBuffer(1024 * 1024);
    buffer.appendBytes(Buffer.from("abcdef", "utf8"));
    const first = buffer.read({ fromCursorBytes: 0, maximumBytes: 2 });
    expect(first.text).toBe("ab");
    expect(first.nextCursorBytes).toBe(2);
    const second = buffer.read({ fromCursorBytes: 2, maximumBytes: 2 });
    expect(second.text).toBe("cd");
    const third = buffer.read({ fromCursorBytes: 4, maximumBytes: 10 });
    expect(third.text).toBe("ef");
  });
});

describe("EXEC-01-03 输出缓冲：ANSI 与存储上限", () => {
  it("ANSI 控制序列被清除（模型不该看到转义码）", () => {
    expect(stripAnsiControlSequences("\u001B[31mred\u001B[0m")).toBe("red");
    expect(stripAnsiControlSequences("\u001B]0;title\u0007text")).toBe("text");
    const buffer = new ProcessOutputStreamBuffer(1024 * 1024);
    buffer.appendBytes(Buffer.from("\u001B[1mbold\u001B[0m\n", "utf8"));
    expect(buffer.read({ fromCursorBytes: 0, maximumBytes: 100 }).text).toBe("bold\n");
  });

  it("超过存储上限 ⇒ 标记截断并停止追加（游标保持稳定）", () => {
    const buffer = new ProcessOutputStreamBuffer(10);
    buffer.appendBytes(Buffer.from("0123456789ABCDEF", "utf8"));
    expect(buffer.getIsStorageLimitReached()).toBe(true);
    expect(buffer.getTotalBytes()).toBe(10);
    const read = buffer.read({ fromCursorBytes: 0, maximumBytes: 100 });
    expect(read.text).toBe("0123456789");
    expect(read.isTruncated).toBe(true);
    /** 继续追加不得再增长（否则游标语义被破坏）。 */
    buffer.appendBytes(Buffer.from("MORE", "utf8"));
    expect(buffer.getTotalBytes()).toBe(10);
  });

  it("未超限时 isTruncated 为 false（不得把正常结束说成截断）", () => {
    const buffer = new ProcessOutputStreamBuffer(1024);
    buffer.appendBytes(Buffer.from("ok", "utf8"));
    const read = buffer.read({ fromCursorBytes: 0, maximumBytes: 100 });
    expect(read.isTruncated).toBe(false);
    expect(read.hasMoreBytes).toBe(false);
  });

  it("全量文本仅供扫描，读取按游标有界", () => {
    const buffer = new ProcessOutputStreamBuffer(1024);
    buffer.appendBytes(Buffer.from("secret-ish payload", "utf8"));
    expect(buffer.readAllTextForScanning()).toBe("secret-ish payload");
    expect(buffer.read({ fromCursorBytes: 0, maximumBytes: 6 }).text).toBe("secret");
  });
});
