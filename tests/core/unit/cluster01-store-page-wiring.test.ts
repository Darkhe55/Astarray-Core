/**
 * CLUSTER-01 切片 3：`DiagnosticEventStore.readEventPages` 接线验证。
 *
 * 卡片要求"保留旧 API 兼容"：`readAll` 必须与分页读取**给出同样的解析结果**，
 * 否则两套读法会互相矛盾（一个算丢行、一个不算）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-store-page-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildEvent(index: number) {
  return {
    eventType: "diagnostic" as const,
    requestIdentifier: `event-${String(index)}`,
    recordedAtIso: "2026-11-11T00:00:00.000Z",
    errorCode: `E${String(index)}`,
    component: "worker",
    stage: "execute",
    messageText: `错误 ${String(index)}`,
    chain: { rootErrorCode: `E${String(index)}`, wrapperErrorCodes: [] },
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    agentInstanceIdentifier: "worker-1",
  };
}

describe("CLUSTER-01 切片 3：store 分页接线", () => {
  it("分页解析结果与 readAll 完全一致（顺序、内容、数量）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 7; index += 1) {
      await store.append(buildEvent(index) as never);
    }

    const allEvents = await store.readAll();
    const paged = await store.readEventPages({ limit: 3 });

    const flattened = paged.pages.flatMap((page) => page.events);
    expect(flattened.map((event) => event.requestIdentifier)).toEqual(
      allEvents.map((event) => event.requestIdentifier),
    );
    expect(paged.isComplete).toBe(true);
    expect(paged.discardedLineCount).toBe(0);
  });

  it("损坏行与非法事件的计数与 readWithIntegrity 一致", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await store.append(buildEvent(1) as never);
    /** 直接写坏行与非诊断事件，模拟历史损坏。 */
    const filePath = path.join(stateDirectory, "diagnostic-events.jsonl");
    await fs.appendFile(filePath, "not-json\n", "utf8");
    await fs.appendFile(filePath, JSON.stringify({ eventType: "summary" }) + "\n", "utf8");
    await store.append(buildEvent(2) as never);

    const integrity = await store.readWithIntegrity();
    const paged = await store.readEventPages({ limit: 2 });

    expect(paged.discardedLineCount).toBe(integrity.discardedLineCount);
    expect(paged.totalEventCount).toBe(integrity.events.length);
    expect(paged.totalEventCount).toBe(2);
  });

  it("受 maximumTotalEvents 限制时提前停止，并如实返回 isComplete=false", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 9; index += 1) {
      await store.append(buildEvent(index) as never);
    }

    const paged = await store.readEventPages({ limit: 2, maximumTotalEvents: 4 });
    expect(paged.totalEventCount).toBeLessThanOrEqual(4);
    expect(paged.isComplete).toBe(false);
    /** 已读到的记录不重复、按原顺序。 */
    expect(paged.pages.flatMap((page) => page.events).map((event) => event.requestIdentifier)).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
    ]);
  });

  it("文件不存在（从未采集）⇒ 视为空源并完整结束，不报错", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: path.join(stateDirectory, "missing-directory") });
    const page = await store.readEventPages();
    expect(page.totalEventCount).toBe(0);
    expect(page.isComplete).toBe(true);
    expect(await store.readAll()).toEqual([]);
    /**
     * 已知缺口（如实记录）：**权限导致的不可读**还没有自动化用例——
     * 在 Windows 上构造"存在但不可读"的文件需要改 ACL（属系统权限变更，本批不做）。
     * 代码路径已区分 ENOENT（空源）与其他错误（`diagnostic-source-unavailable`），但后者未被测到。
     */
  });
});
