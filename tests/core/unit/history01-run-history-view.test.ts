/**
 * HISTORY-01-03 的**反例**（2026-10-18）：运行历史的只读视图层。
 *
 * 卡内 §3/§4/§5 的可本地验证缺口逐条钉住：
 *  - 游标分页不重复不遗漏，追加新事件不让既有页重复；
 *  - `resume` 分界成为可识别的事件与段落，旧段不覆盖；
 *  - 三个显示开关**只影响视图**：关闭后事件仍在磁盘上（`storedEventCount` 如实）；
 *  - 没有过程说明时给出固定文案，不空白假装完整；
 *  - 不可信文本（ANSI/OSC/控制字节）不进入终端，移除处留可见占位；
 *  - 长详情截断如实标记；payload 非法 JSON 如实标记；
 *  - 列表页只读当前页文件、损坏文件保留且可见。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { RunHistoryStore } from "../../../packages/core/src/orchestration/run-history-store.js";
import {
  DEFAULT_RUN_HISTORY_PAGE_SIZE,
  HIDDEN_PROCESS_EXPLANATION_NOTICE,
  HIDDEN_RUN_HISTORY_NOTICE,
  MAXIMUM_RUN_HISTORY_DETAIL_CHARACTERS,
  MAXIMUM_RUN_HISTORY_PAGE_SIZE,
  MISSING_PROCESS_EXPLANATION_NOTICE,
  REMOVED_CONTROL_SEQUENCE_PLACEHOLDER,
  buildRunHistoryEvidenceAnchor,
  buildRunHistoryTimelinePage,
  listRunHistoryMissions,
  queryRunHistoryTimeline,
  sanitizeRunHistoryDisplayText,
  type RunHistoryDocument,
} from "../../../packages/core/src/orchestration/run-history-view.js";

let baseDirectory: string;
let store: RunHistoryStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-run-history-view-"));
  store = new RunHistoryStore({ baseDirectory });
});

function event(
  identifier: string,
  kind: string,
  recordedAtIso = "2026-10-18T00:00:00.000Z",
  payload: unknown = {},
) {
  return {
    eventIdentifier: identifier,
    kind: kind as never,
    recordedAtIso,
    payloadJson: JSON.stringify(payload),
  };
}

/** 两段文档：第 1 段 2 条，第 2 段（resume 后）2 条。 */
function twoSegmentDocument(): RunHistoryDocument {
  return {
    schemaVersion: 1,
    missionIdentifier: "mission-two-segments",
    segments: [
      {
        segmentRevision: 1,
        startedAtIso: "2026-10-18T00:00:00.000Z",
        events: [
          event("a1", "tool-call", "2026-10-18T00:00:01.000Z", { toolName: "readFile" }),
          event("a2", "tool-failure", "2026-10-18T00:00:02.000Z", {
            toolName: "writeFile",
            failureReason: "permission-denied",
          }),
        ],
      },
      {
        segmentRevision: 2,
        startedAtIso: "2026-10-18T01:00:00.000Z",
        events: [
          event("r1", "resume-boundary", "2026-10-18T01:00:00.000Z", { checkpoint: "cp-1" }),
          event("a3", "tool-call", "2026-10-18T01:00:01.000Z", { toolName: "readFile" }),
        ],
      },
    ],
  };
}

describe("HISTORY-01-03：运行历史只读视图（分页 / 过滤 / 安全渲染 / 显示开关）", () => {
  it("① 序号跨段连续，段号与种类标签如实（恢复分界可识别）", () => {
    const page = buildRunHistoryTimelinePage({ document: twoSegmentDocument() });
    expect(page.entries.map((entry) => entry.sequenceNumber)).toEqual([1, 2, 3, 4]);
    expect(page.entries.map((entry) => entry.segmentRevision)).toEqual([1, 1, 2, 2]);
    expect(page.entries.map((entry) => entry.kindLabel)).toEqual([
      "工具调用",
      "工具失败",
      "恢复分界",
      "工具调用",
    ]);
    expect(page.resumeBoundaryCount).toBe(1);
    expect(page.segmentCount).toBe(2);
    expect(page.storedEventCount).toBe(4);
  });

  it("② 游标分页：不重复、不遗漏；追加新事件后旧页不重复", () => {
    const firstPage = buildRunHistoryTimelinePage({
      document: twoSegmentDocument(),
      pageSize: 3,
    });
    expect(firstPage.entries.map((entry) => entry.sequenceNumber)).toEqual([1, 2, 3]);
    expect(firstPage.nextCursor).toBe(3);

    const secondPage = buildRunHistoryTimelinePage({
      document: twoSegmentDocument(),
      pageSize: 3,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.entries.map((entry) => entry.sequenceNumber)).toEqual([4]);
    expect(secondPage.nextCursor).toBeNull();

    // 追加一条新事件后，从游标 3 继续：仍然只看到 4，不会重复 1–3
    const appended = twoSegmentDocument();
    appended.segments[1]?.events.push(
      event("a4", "tool-call", "2026-10-18T01:00:02.000Z", { toolName: "readFile" }),
    );
    const afterAppend = buildRunHistoryTimelinePage({
      document: appended,
      pageSize: 3,
      cursor: firstPage.nextCursor,
    });
    expect(afterAppend.entries.map((entry) => entry.sequenceNumber)).toEqual([4, 5]);
  });

  it("③ 关闭工具显示：条目被隐藏，但**磁盘上事件仍在**（storedEventCount 如实）", async () => {
    const document = twoSegmentDocument();
    await fs.mkdir(path.join(baseDirectory, "run-history"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "run-history", "mission-two-segments.json"),
      JSON.stringify(document),
      "utf8",
    );

    const hidden = buildRunHistoryTimelinePage({
      document,
      displaySettings: { showToolCalls: false },
    });
    expect(hidden.entries.map((entry) => entry.kind)).toEqual(["resume-boundary"]);
    expect(hidden.storedEventCount).toBe(4);
    expect(hidden.hiddenEventCount).toBe(3);

    // 磁盘未被动过：store 仍能读回全部 4 条
    const onDisk = await store.read("mission-two-segments");
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind !== "valid") throw new Error("应为 valid");
    expect(onDisk.document.segments.flatMap((segment) => segment.events)).toHaveLength(4);
  });

  it("④ 过程说明：没有就是「该运行未提供过程说明」；有但被隐藏则说明「仍保存在本地」", () => {
    const withoutNotes = twoSegmentDocument();
    const missingNotice = buildRunHistoryTimelinePage({ document: withoutNotes });
    expect(missingNotice.notice).toBe(MISSING_PROCESS_EXPLANATION_NOTICE);

    const withNote = twoSegmentDocument();
    withNote.segments[0]?.events.push(
      event("n1", "model-note", "2026-10-18T00:00:03.000Z", { note: "先读后写" }),
    );
    const hiddenNotice = buildRunHistoryTimelinePage({ document: withNote });
    expect(hiddenNotice.notice).toBe(HIDDEN_PROCESS_EXPLANATION_NOTICE);
    expect(hiddenNotice.entries.map((entry) => entry.kind)).not.toContain("model-note");

    const shownNotice = buildRunHistoryTimelinePage({
      document: withNote,
      displaySettings: { showProcessExplanations: true },
    });
    expect(shownNotice.notice).toBeNull();
    expect(shownNotice.entries.map((entry) => entry.kind)).toContain("model-note");
  });

  it("⑤ 关闭总显示开关：视图为空，但计数与通知如实（不伪装「没有历史」）", () => {
    const page = buildRunHistoryTimelinePage({
      document: twoSegmentDocument(),
      displaySettings: { showRunHistory: false },
    });
    expect(page.isHiddenByDisplaySettings).toBe(true);
    expect(page.entries).toEqual([]);
    expect(page.storedEventCount).toBe(4);
    // 总开关关闭 ⇒ **全部**事件都算隐藏（不是只算工具/过程说明那几类）
    expect(page.hiddenEventCount).toBe(4);
    expect(page.eligibleEventCount).toBe(0);
    expect(page.notice).toBe(HIDDEN_RUN_HISTORY_NOTICE);
    expect(page.nextCursor).toBeNull();
  });

  it("⑥ 不可信文本：ANSI/OSC/控制字节不进入展示文本，移除处留可见占位", () => {
    expect(sanitizeRunHistoryDisplayText("\u001B[31mred\u001B[0m")).toBe(
      `${REMOVED_CONTROL_SEQUENCE_PLACEHOLDER}red${REMOVED_CONTROL_SEQUENCE_PLACEHOLDER}`,
    );
    // OSC 超链接：不得把 URL 留在终端可点击状态
    expect(
      sanitizeRunHistoryDisplayText("\u001B]8;;https://example.invalid\u0007text\u001B]8;;\u0007"),
    ).toBe(`${REMOVED_CONTROL_SEQUENCE_PLACEHOLDER}text${REMOVED_CONTROL_SEQUENCE_PLACEHOLDER}`);
    // 裸控制字节（BEL、退格、NUL）被剥离；换行/制表保留
    expect(sanitizeRunHistoryDisplayText("a\u0007b\u0000c\td\ne")).toBe("abc\td\ne");
    // CRLF 归一化，避免回车覆盖已显示内容
    expect(sanitizeRunHistoryDisplayText("line1\r\nline2\rline3")).toBe("line1\nline2\nline3");
  });

  it("⑦ 长详情截断如实标记；payload 非法 JSON 如实标记并脱敏展示", () => {
    const longDocument: RunHistoryDocument = {
      schemaVersion: 1,
      missionIdentifier: "mission-long",
      segments: [
        {
          segmentRevision: 1,
          startedAtIso: "2026-10-18T00:00:00.000Z",
          events: [
            {
              eventIdentifier: "long",
              kind: "tool-call",
              recordedAtIso: "2026-10-18T00:00:00.000Z",
              payloadJson: JSON.stringify({ outputText: "x".repeat(9_000) }),
            },
            {
              eventIdentifier: "broken",
              kind: "model-note",
              recordedAtIso: "2026-10-18T00:00:01.000Z",
              payloadJson: "\u001B[31mnot-json",
            },
          ],
        },
      ],
    };

    const page = buildRunHistoryTimelinePage({
      document: longDocument,
      displaySettings: { showProcessExplanations: true },
    });
    const [truncatedEntry, brokenEntry] = page.entries;
    expect(truncatedEntry?.isDetailTruncated).toBe(true);
    expect(truncatedEntry?.detailText).toHaveLength(MAXIMUM_RUN_HISTORY_DETAIL_CHARACTERS);
    expect(brokenEntry?.isPayloadUnreadable).toBe(true);
    expect(brokenEntry?.detailText).not.toContain("\u001B");
    expect(brokenEntry?.detailText).toContain("not-json");
  });

  it("⑧ 页大小夹取：超大夹到上限，非法值回落默认", () => {
    expect(
      buildRunHistoryTimelinePage({ document: twoSegmentDocument(), pageSize: 10_000 })
        .effectivePageSize,
    ).toBe(MAXIMUM_RUN_HISTORY_PAGE_SIZE);
    expect(
      buildRunHistoryTimelinePage({ document: twoSegmentDocument(), pageSize: -5 })
        .effectivePageSize,
    ).toBe(DEFAULT_RUN_HISTORY_PAGE_SIZE);
    expect(
      buildRunHistoryTimelinePage({ document: twoSegmentDocument(), pageSize: Number.NaN })
        .effectivePageSize,
    ).toBe(DEFAULT_RUN_HISTORY_PAGE_SIZE);
    // 不足 1 的页大小夹到 1，不得变成「取 0 条」（否则游标永远不前进）
    expect(
      buildRunHistoryTimelinePage({ document: twoSegmentDocument(), pageSize: 0.5 })
        .effectivePageSize,
    ).toBe(1);
  });

  it("⑨ 种类过滤：给定种类即只保留它；空数组 ⇒ 明确「一条都不要」", () => {
    const toolCallsOnly = buildRunHistoryTimelinePage({
      document: twoSegmentDocument(),
      includedKinds: ["tool-call"],
    });
    expect(toolCallsOnly.entries.map((entry) => entry.kind)).toEqual(["tool-call", "tool-call"]);

    const explicitlyEmpty = buildRunHistoryTimelinePage({
      document: twoSegmentDocument(),
      includedKinds: [],
    });
    expect(explicitlyEmpty.entries).toEqual([]);
    expect(explicitlyEmpty.storedEventCount).toBe(4);
  });

  it("⑩ 真实读盘：absent / invalid 如实报，不伪造空历史", async () => {
    expect((await queryRunHistoryTimeline({ baseDirectory, missionIdentifier: "nope" })).kind).toBe(
      "absent",
    );

    await fs.mkdir(path.join(baseDirectory, "run-history"), { recursive: true });
    await fs.writeFile(path.join(baseDirectory, "run-history", "bad.json"), "{broken", "utf8");
    const invalidOutcome = await queryRunHistoryTimeline({
      baseDirectory,
      missionIdentifier: "bad",
    });
    expect(invalidOutcome.kind).toBe("invalid");

    await store.appendEvent({
      missionIdentifier: "m-ok",
      event: event("e1", "tool-call", "2026-10-18T00:00:00.000Z", { toolName: "readFile" }),
    });
    const validOutcome = await queryRunHistoryTimeline({
      baseDirectory,
      missionIdentifier: "m-ok",
    });
    expect(validOutcome.kind).toBe("valid");
    if (validOutcome.kind !== "valid") throw new Error("应为 valid");
    expect(validOutcome.page.entries).toHaveLength(1);
  });

  it("⑪ 列表：只读当前页文件、最近优先、损坏文件保留可见、文件名与内部标识不一致不误判", async () => {
    const historyDirectory = path.join(baseDirectory, "run-history");
    await fs.mkdir(historyDirectory, { recursive: true });
    const writeDocument = async (fileName: string, document: RunHistoryDocument) =>
      await fs.writeFile(path.join(historyDirectory, fileName), JSON.stringify(document), "utf8");

    await writeDocument("m-old.json", {
      schemaVersion: 1,
      missionIdentifier: "m-old",
      segments: [
        {
          segmentRevision: 1,
          startedAtIso: "2026-10-18T00:00:00.000Z",
          events: [event("e1", "tool-call")],
        },
      ],
    });
    // 文件名是 sanitize 后的 `m-new.json`，而文档自述标识是含空格的 `m new`
    // ⇒ 不得因为文件名对不上就误判成损坏，也不得丢掉真实标识。
    await writeDocument("m-new.json", {
      schemaVersion: 1,
      missionIdentifier: "m new",
      segments: [
        {
          segmentRevision: 1,
          startedAtIso: "2026-10-18T02:00:00.000Z",
          events: [event("e2", "tool-call"), event("e3", "tool-failure")],
        },
      ],
    });
    await writeDocument("m-broken.json", { schemaVersion: 2 } as never);
    await fs.writeFile(path.join(historyDirectory, "m-garbage.json"), "not-json", "utf8");
    // 非 JSON 文件不应进入列表
    await fs.writeFile(path.join(historyDirectory, "notes.txt"), "ignore me", "utf8");

    // 固定四条文件的 mtime，使「最近优先」排序确定：m new > m-old > m-broken > m-garbage
    const setModifiedAt = async (fileName: string, isoDateTime: string) => {
      const timestamp = new Date(isoDateTime);
      await fs.utimes(path.join(historyDirectory, fileName), timestamp, timestamp);
    };
    await setModifiedAt("m-new.json", "2026-10-18T04:00:00.000Z");
    await setModifiedAt("m-old.json", "2026-10-18T03:00:00.000Z");
    await setModifiedAt("m-broken.json", "2026-10-18T02:00:00.000Z");
    await setModifiedAt("m-garbage.json", "2026-10-18T01:00:00.000Z");

    const readPaths: string[] = [];
    const page = await listRunHistoryMissions({
      baseDirectory,
      pageSize: 2,
      onHistoryRead: (historyFilePath) => readPaths.push(path.basename(historyFilePath)),
    });

    expect(page.totalMissionCount).toBe(4);
    expect(page.entries.map((entry) => entry.missionIdentifier)).toEqual(["m new", "m-old"]);
    expect(page.entries[0]?.eventCount).toBe(2);
    expect(page.entries[0]?.isCorrupted).toBe(false);
    expect(page.hasMorePages).toBe(true);
    // 只读当前页的两个文件（不是全部）
    expect(readPaths.sort()).toEqual(["m-new.json", "m-old.json"]);

    const secondPage = await listRunHistoryMissions({
      baseDirectory,
      pageSize: 2,
      pageIndex: 1,
    });
    const corrupted = secondPage.entries.filter((entry) => entry.isCorrupted);
    expect(corrupted.map((entry) => entry.missionIdentifier).sort()).toEqual([
      "m-broken",
      "m-garbage",
    ]);
    // 损坏条目带原因，不静默丢弃
    expect(corrupted.every((entry) => entry.reason !== null)).toBe(true);
    expect(secondPage.hasMorePages).toBe(false);
  });

  it("⑬ 边界分支：负数页码、未知游标、原始值/数组 payload、双字符 ESC 与未终止 OSC", async () => {
    // 负数页码夹到 0（不抛错、不返回空）
    for (const missionIdentifier of ["m-a", "m-b"]) {
      await store.appendEvent({
        missionIdentifier,
        event: event(`e-${missionIdentifier}`, "tool-call"),
      });
    }
    const negativePage = await listRunHistoryMissions({ baseDirectory, pageIndex: -3 });
    expect(negativePage.pageIndex).toBe(0);
    expect(negativePage.entries).toHaveLength(2);

    // 未知游标 ⇒ 回到第一页（不静默返回空）
    const unknownCursor = await listRunHistoryMissions({
      baseDirectory,
      afterMissionIdentifier: "no-such-mission",
    });
    expect(unknownCursor.entries.length).toBeGreaterThan(0);
    // 目录不是历史记录 ⇒ 不进入列表（也不会被当成损坏条目）
    await fs.mkdir(path.join(baseDirectory, "run-history", "m-directory.json"), {
      recursive: true,
    });
    const afterDirectory = await listRunHistoryMissions({ baseDirectory, pageSize: 10 });
    expect(
      afterDirectory.entries.some((entry) => entry.missionIdentifier === "m-directory"),
    ).toBe(false);

    // 原始值 / 数组 payload：不得抛错，且不得把控制序列交给终端
    const primitiveDocument: RunHistoryDocument = {
      schemaVersion: 1,
      missionIdentifier: "mission-primitives",
      segments: [
        {
          segmentRevision: 1,
          startedAtIso: "2026-10-18T00:00:00.000Z",
          events: [
            { eventIdentifier: "p1", kind: "tool-call", recordedAtIso: "2026-10-18T00:00:00.000Z", payloadJson: "42" },
            { eventIdentifier: "p2", kind: "tool-call", recordedAtIso: "2026-10-18T00:00:01.000Z", payloadJson: "null" },
            { eventIdentifier: "p3", kind: "tool-call", recordedAtIso: "2026-10-18T00:00:02.000Z", payloadJson: "[1,2]" },
            {
              eventIdentifier: "p4",
              kind: "tool-call",
              recordedAtIso: "2026-10-18T00:00:03.000Z",
              payloadJson: JSON.stringify({ outputText: "\u001Bc复位\u001B]8;;https://example.invalid" }),
            },
          ],
        },
      ],
    };
    const page = buildRunHistoryTimelinePage({ document: primitiveDocument, pageSize: 10 });
    expect(page.entries.map((entry) => entry.isPayloadUnreadable)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(page.entries[2]?.detailText).toContain("1");
    expect(page.entries[3]?.detailText).not.toContain("\u001B");
    expect(page.entries[3]?.detailText).toContain(REMOVED_CONTROL_SEQUENCE_PLACEHOLDER);
  });

  it("⑫ 列表：空目录（未产生历史）⇒ 空页而不是报错；游标按当前排序位置继续", async () => {
    const emptyPage = await listRunHistoryMissions({ baseDirectory });
    expect(emptyPage.entries).toEqual([]);
    expect(emptyPage.totalMissionCount).toBe(0);
    expect(emptyPage.hasMorePages).toBe(false);

    for (const missionIdentifier of ["m-a", "m-b", "m-c"]) {
      await store.appendEvent({
        missionIdentifier,
        event: event(`e-${missionIdentifier}`, "tool-call"),
      });
    }
    const firstPage = await listRunHistoryMissions({ baseDirectory, pageSize: 1 });
    expect(firstPage.entries).toHaveLength(1);
    const cursor = firstPage.entries[0]?.missionIdentifier;
    expect(cursor).toBeDefined();

    const nextPage = await listRunHistoryMissions({
      baseDirectory,
      pageSize: 5,
      afterMissionIdentifier: cursor,
    });
    expect(nextPage.entries.map((entry) => entry.missionIdentifier)).not.toContain(cursor);
    expect(nextPage.entries).toHaveLength(2);
  });

  it("⑭ 关键词检索：纯子串、大小写不敏感、不解释正则；只搜可见事件；命中数为分页前计数", () => {
    const document: RunHistoryDocument = {
      schemaVersion: 1,
      missionIdentifier: "mission-search",
      segments: [
        {
          segmentRevision: 1,
          startedAtIso: "2026-10-18T00:00:00.000Z",
          events: [
            event("s1", "tool-call", "2026-10-18T00:00:01.000Z", {
              toolName: "readFile",
              outputText: "Permission DENIED for path",
            }),
            event("s2", "tool-call", "2026-10-18T00:00:02.000Z", {
              outputText: "axxb looks like a pattern",
            }),
            event("s3", "model-note", "2026-10-18T00:00:03.000Z", {
              note: "permission 相关的过程说明",
            }),
            event("s4", "tool-call", "2026-10-18T00:00:04.000Z", {
              outputText: "nothing relevant",
            }),
          ],
        },
      ],
    };

    // 大小写不敏感 + 子串
    const insensitive = buildRunHistoryTimelinePage({
      document,
      searchQuery: "permission denied",
    });
    expect(insensitive.entries.map((entry) => entry.eventIdentifier)).toEqual(["s1"]);
    expect(insensitive.searchQuery).toBe("permission denied");
    expect(insensitive.searchMatchCount).toBe(1);
    // 分页前计数：pageSize=1 时命中总数仍是 1
    expect(insensitive.entries).toHaveLength(1);

    // **正则字符按字面量**：`a.*b` 不得把 `axxb` 搜出来
    const literal = buildRunHistoryTimelinePage({ document, searchQuery: "a.*b" });
    expect(literal.entries).toEqual([]);
    expect(literal.searchMatchCount).toBe(0);

    // 只搜**可见**事件：默认隐藏过程说明 ⇒ s3 不应命中
    const hiddenKinds = buildRunHistoryTimelinePage({ document, searchQuery: "过程说明" });
    expect(hiddenKinds.entries).toEqual([]);
    expect(hiddenKinds.searchMatchCount).toBe(0);
    const shownKinds = buildRunHistoryTimelinePage({
      document,
      searchQuery: "过程说明",
      displaySettings: { showProcessExplanations: true },
    });
    expect(shownKinds.entries.map((entry) => entry.eventIdentifier)).toEqual(["s3"]);

    // 空白检索词 = 不检索（不返回「0 命中」的假检索态）
    const blank = buildRunHistoryTimelinePage({ document, searchQuery: "   " });
    expect(blank.searchQuery).toBeNull();
    expect(blank.searchMatchCount).toBeNull();
    expect(blank.entries).toHaveLength(3); // 默认隐藏 model-note ⇒ 4 - 1

    // 总显示开关关闭时**没有检索**（不得报 0 命中冒充搜过）
    const hiddenAll = buildRunHistoryTimelinePage({
      document,
      searchQuery: "permission",
      displaySettings: { showRunHistory: false },
    });
    expect(hiddenAll.searchQuery).toBeNull();
    expect(hiddenAll.searchMatchCount).toBeNull();
  });

  it("⑮ 稳定证据锚点：格式固定、同序号唯一、跨页不漂移", () => {
    const document = twoSegmentDocument();
    const firstPage = buildRunHistoryTimelinePage({
      document,
      pageSize: 2,
      searchQuery: undefined,
    });
    expect(firstPage.entries.map((entry) => entry.evidenceAnchor)).toEqual([
      "run-history:mission-two-segments#1",
      "run-history:mission-two-segments#2",
    ]);

    const secondPage = buildRunHistoryTimelinePage({
      document,
      pageSize: 2,
      cursor: firstPage.nextCursor,
    });
    // 追加新事件后，既有条目的锚点**不变**（序号单调）
    const appended = twoSegmentDocument();
    appended.segments[0]?.events.push(
      event("extra", "tool-call", "2026-10-18T00:00:09.000Z", { toolName: "readFile" }),
    );
    const appendedPage = buildRunHistoryTimelinePage({
      document: appended,
      pageSize: 3,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.entries[0]?.sequenceNumber).toBe(appendedPage.entries[0]?.sequenceNumber);
    expect(appendedPage.entries[0]?.evidenceAnchor).toBe(
      buildRunHistoryEvidenceAnchor("mission-two-segments", appendedPage.entries[0]?.sequenceNumber ?? 0),
    );
    // 锚点按序号唯一
    const allAnchors = [...firstPage.entries, ...secondPage.entries].map(
      (entry) => entry.evidenceAnchor,
    );
    expect(new Set(allAnchors).size).toBe(allAnchors.length);
  });
});
