/**
 * HISTORY-01-02 的**反例**（2026-10-18 第 36 轮）：运行历史数据层。
 *
 * 必须：工具调用与失败调用都在、resume 分段不覆盖旧事件、重复事件去重、坏日志如实报错。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { RunHistoryStore } from "../../../packages/core/src/orchestration/run-history-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-run-history-"));
});

function event(identifier: string, kind: string, payload = "{}") {
  return {
    eventIdentifier: identifier,
    kind: kind as never,
    recordedAtIso: "2026-10-18T00:00:00.000Z",
    payloadJson: payload,
  };
}

describe("HISTORY-01-02：运行历史（最小持久化）", () => {
  it("① 追加后能读回；工具调用与**失败调用（含原因）**都在", async () => {
    const store = new RunHistoryStore({ baseDirectory });
    await store.appendEvent({
      missionIdentifier: "mission-1",
      event: event("e1", "tool-call", JSON.stringify({ toolName: "readFile" })),
    });
    await store.appendEvent({
      missionIdentifier: "mission-1",
      event: event(
        "e2",
        "tool-failure",
        JSON.stringify({ toolName: "readFile", failureReason: "permission-denied" }),
      ),
    });

    const outcome = await store.read("mission-1");
    expect(outcome.kind).toBe("valid");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    const events = outcome.document.segments.flatMap((segment) => segment.events);
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "tool-failure"]);
    expect(events[1]?.payloadJson).toContain("permission-denied");
  });

  it("② resume 分界 ⇒ 开新段，**旧段旧事件原样保留**", async () => {
    const store = new RunHistoryStore({ baseDirectory });
    await store.appendEvent({ missionIdentifier: "m", event: event("a1", "tool-call") });
    const appended = await store.appendEvent({
      missionIdentifier: "m",
      event: event("r1", "resume-boundary"),
    });
    expect(appended.segmentRevision).toBe(2);

    const outcome = await store.read("m");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    expect(outcome.document.segments).toHaveLength(2);
    expect(outcome.document.segments[0]?.events.map((e) => e.eventIdentifier)).toEqual(["a1"]);
  });

  it("③ 重复事件 ⇒ **去重**（wasAppended=false，且不新增）", async () => {
    const store = new RunHistoryStore({ baseDirectory });
    await store.appendEvent({ missionIdentifier: "m", event: event("dup", "tool-call") });
    const second = await store.appendEvent({
      missionIdentifier: "m",
      event: event("dup", "tool-call"),
    });
    expect(second.wasAppended).toBe(false);
    expect(second.reason).toContain("去重");

    const outcome = await store.read("m");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    expect(outcome.document.segments.flatMap((s) => s.events)).toHaveLength(1);
  });

  it("④ 坏 JSON ⇒ invalid，且**拒绝写入**（不覆盖用户历史）", async () => {
    const directory = path.join(baseDirectory, "run-history");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "m.json"), "{broken", "utf8");

    const store = new RunHistoryStore({ baseDirectory });
    const outcome = await store.read("m");
    expect(outcome.kind).toBe("invalid");

    const appendOutcome = await store.appendEvent({
      missionIdentifier: "m",
      event: event("x", "tool-call"),
    });
    expect(appendOutcome.wasAppended).toBe(false);
    expect(appendOutcome.reason).toContain("损坏");
  });

  it("④b 真实钩子路径：成功与**失败**两类事件都进历史，且失败原因保留", async () => {
    const store = new RunHistoryStore({ baseDirectory });
    // 模拟 tool-loop 的两个钩子（onToolSucceeded / onToolFailed）
    await store.recordToolCall({
      missionIdentifier: "m",
      toolName: "readFile",
      outputText: "file-content",
    });
    await store.recordToolFailure({
      missionIdentifier: "m",
      toolName: "writeFile",
      failureReason: "permission-denied",
    });

    const outcome = await store.read("m");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    const events = outcome.document.segments.flatMap((segment) => segment.events);
    expect(events.map((event) => event.kind)).toEqual(["tool-call", "tool-failure"]);
    expect(events[1]?.payloadJson).toContain("permission-denied");
  });

  it("④c 同一工具同一输出重复记录 ⇒ 去重（不重复增长）", async () => {
    const store = new RunHistoryStore({ baseDirectory });
    const first = await store.recordToolCall({ missionIdentifier: "m", toolName: "readFile", outputText: "same" });
    const second = await store.recordToolCall({ missionIdentifier: "m", toolName: "readFile", outputText: "same" });
    expect(first.wasAppended).toBe(true);
    expect(second.wasAppended).toBe(false);
  });

  it("⑤ 无文件 ⇒ absent", async () => {
    const store = new RunHistoryStore({ baseDirectory });
    const outcome = await store.read("nope");
    expect(outcome.kind).toBe("absent");
  });

  it("⑥ 版本不认识 / mission 不符 ⇒ invalid（不按 v1 解释）", async () => {
    const directory = path.join(baseDirectory, "run-history");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "m.json"),
      JSON.stringify({ schemaVersion: 2, missionIdentifier: "m", segments: [] }),
      "utf8",
    );
    const store = new RunHistoryStore({ baseDirectory });
    expect((await store.read("m")).kind).toBe("invalid");

    await fs.writeFile(
      path.join(directory, "m.json"),
      JSON.stringify({ schemaVersion: 1, missionIdentifier: "other", segments: [] }),
      "utf8",
    );
    expect((await store.read("m")).kind).toBe("invalid");
  });
});
