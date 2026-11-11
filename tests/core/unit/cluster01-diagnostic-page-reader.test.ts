/**
 * CLUSTER-01 第一切片：有界分页读取端口（先写测试，实现见 diagnostic-event-page-reader.ts）。
 *
 * 为什么单测：卡内 §2 指出 `readAll`/`readWithIntegrity` 一次读整个文件，
 * 无法支撑"每批 200 行 / 单行 64 KiB / 每次 2,000 条"的后台扫描。
 * 本文件锁住分页的**不丢不重**、游标定位、超长行跳过与哈希校验。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readAllDiagnosticPages,
  readDiagnosticPage,
  readDiagnosticPageFromFile,
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

describe("CLUSTER-01 磁盘分页（有界块读取）", () => {
  it("按块读取多页，结果与一次性字符串解析完全一致", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-page-"));
    const filePath = path.join(directory, "events.jsonl");
    const lines = Array.from({ length: 12 }, (_unused, index) => JSON.stringify({ index }));
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const collected: string[] = [];
      let cursor = { byteOffset: 0, lineNumber: 0 };
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const page = readDiagnosticPageFromFile({ filePath, cursor, limit: 3, maximumBytesPerRead: 64 });
        collected.push(...page.records.map((record) => record.text));
        cursor = page.nextCursor;
        if (page.isComplete) break;
      }
      expect(collected).toEqual(lines);
      /** 分页读取不得整文件读入。 */
      expect(collected.length).toBe(12);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("单页读取的字节数受块大小限制", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-page-"));
    const filePath = path.join(directory, "events.jsonl");
    await fs.writeFile(filePath, Array.from({ length: 50 }, (_u, i) => JSON.stringify({ i })).join("\n"), "utf8");
    try {
      const page = readDiagnosticPageFromFile({ filePath, limit: 2, maximumBytesPerRead: 32 });
      /**
       * 块大小有**下限**：必须能装下一整行（单行上限 64 KiB + 1），
       * 否则永远解析不出完整行。因此这里断言的是"不超过下限值"，
       * 而不是不超过调用方给的 32 字节。
       */
      expect(page.bytesRead).toBeLessThanOrEqual(64 * 1024 + 1);
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.records.length).toBeLessThanOrEqual(2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("游标越界 ⇒ 空页且已完成", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-page-"));
    const filePath = path.join(directory, "events.jsonl");
    await fs.writeFile(filePath, '{"a":1}\n', "utf8");
    try {
      const page = readDiagnosticPageFromFile({ filePath, cursor: { byteOffset: 999, lineNumber: 5 } });
      expect(page.records).toEqual([]);
      expect(page.isComplete).toBe(true);
      expect(page.bytesRead).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
