/**
 * CLUSTER-01 第一切片：有界分页读取端口（先写测试，实现见 diagnostic-event-page-reader.ts）。
 *
 * 为什么单测：卡内 §2 指出 `readAll`/`readWithIntegrity` 一次读整个文件，
 * 无法支撑"每批 200 行 / 单行 64 KiB / 每次 2,000 条"的后台扫描。
 * 本文件锁住分页的**不丢不重**、游标定位、超长行跳过与哈希校验。
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  readAllDiagnosticPages,
  readDiagnosticPage,
} from "../../../packages/core/src/orchestration/diagnostic-event-page-reader.js";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("CLUSTER-01 分页读取端口", () => {
  it("多页读完不丢不重，行号与偏移连续", () => {
    const lines = Array.from({ length: 7 }, (_unused, index) => JSON.stringify({ index }));
    const content = lines.join("\n");
    const pages = readAllDiagnosticPages({ content, limit: 3 });
    const flattened = pages.flatMap((page) => page.records);
    expect(flattened.map((record) => record.lineNumber)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(flattened.map((record) => record.text)).toEqual(lines);
    /** 偏移严格递增，且第一条为 0。 */
    const offsets = flattened.map((record) => record.byteOffset);
    expect(offsets[0]).toBe(0);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]!).toBeGreaterThan(offsets[index - 1]!);
    }
  });

  it("每条记录的内容哈希可用于校验引用", () => {
    const content = '{"a":1}\n{"b":2}\n';
    const page = readDiagnosticPage({ content, limit: 10 });
    expect(page.records.map((record) => record.contentSha256)).toEqual([sha256('{"a":1}'), sha256('{"b":2}')]);
  });

  it("空行不算记录但游标照常前进", () => {
    const content = '{"a":1}\n\n\n{"b":2}\n';
    const page = readDiagnosticPage({ content, limit: 10 });
    expect(page.records.map((record) => record.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(page.records.map((record) => record.lineNumber)).toEqual([0, 3]);
    expect(page.isComplete).toBe(true);
  });

  it("CRLF 文件不把 \\r 带进文本，且哈希按去 \\r 后的内容计算", () => {
    const content = '{"a":1}\r\n{"b":2}\r\n';
    const page = readDiagnosticPage({ content, limit: 10 });
    expect(page.records.map((record) => record.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(page.records[0]!.contentSha256).toBe(sha256('{"a":1}'));
  });

  it("末尾无换行的最后一行仍可读", () => {
    const content = '{"a":1}\n{"b":2}';
    const page = readDiagnosticPage({ content, limit: 10 });
    expect(page.records.map((record) => record.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(page.isComplete).toBe(true);
  });

  it("超长行被跳过并计数，其余记录仍可读（不得整批失败）", () => {
    const longLine = "x".repeat(2_000);
    const content = ['{"a":1}', longLine, '{"b":2}'].join("\n");
    const page = readDiagnosticPage({ content, limit: 10, maximumLineBytesPerLine: 1_000 });
    expect(page.records.map((record) => record.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(page.skippedOversizeLineCount).toBe(1);
    expect(page.records.map((record) => record.lineNumber)).toEqual([0, 2]);
  });

  it("空文本 ⇒ 空页且已完成；再读仍是空页", () => {
    const first = readDiagnosticPage({ content: "" });
    expect(first.records).toEqual([]);
    expect(first.isComplete).toBe(true);
    const second = readDiagnosticPage({ content: "", cursor: first.nextCursor });
    expect(second.records).toEqual([]);
    expect(second.isComplete).toBe(true);
  });

  it("游标可以跨页精确续读（分批 1 行与一次性读结果一致）", () => {
    const lines = Array.from({ length: 5 }, (_unused, index) => JSON.stringify({ index }));
    const content = lines.join("\n");
    const oneByOne: string[] = [];
    let cursor = { byteOffset: 0, lineNumber: 0 };
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = readDiagnosticPage({ content, cursor, limit: 1 });
      oneByOne.push(...page.records.map((record) => record.text));
      cursor = page.nextCursor;
    }
    expect(oneByOne).toEqual(lines);
  });
});
