/**
 * HISTORY-01-03：CLI 命令函数的**进程内**反例（2026-10-18）。
 *
 * 为什么还要这一份（另有真实 `dist/cli.js` 子进程用例）：
 * 子进程用例跑的是**构建产物**，v8 覆盖率不会归属到 `src` ⇒ `history-command.ts`
 * 在 `test:coverage` 里曾是 **0%**，把全局分支覆盖率压到 85% 阈值以下。
 * 本文件直接调用命令函数，既补覆盖率，也钉住**文本输出**与**失败路径**
 * （子进程用例只断言 JSON 与退出码）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunHistoryStore } from "../../../packages/core/src/orchestration/run-history-store.js";
import {
  executeHistoryListCommand,
  executeHistoryShowCommand,
  resolveIncludedKinds,
} from "../../../packages/tui/src/cli/history-command.js";

let stateDirectory: string;
let stdoutText: string;
let stderrText: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-history01-command-"));
  stdoutText = "";
  stderrText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrText += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function seed(): Promise<void> {
  const store = new RunHistoryStore({ baseDirectory: stateDirectory });
  await store.appendEvent({
    missionIdentifier: "mission-text",
    event: {
      eventIdentifier: "e1",
      kind: "tool-call",
      recordedAtIso: "2026-10-18T00:00:00.000Z",
      payloadJson: JSON.stringify({ toolName: "readFile", outputText: "content" }),
    },
  });
  await store.appendEvent({
    missionIdentifier: "mission-text",
    event: {
      eventIdentifier: "e2",
      kind: "resume-boundary",
      recordedAtIso: "2026-10-18T00:00:05.000Z",
      payloadJson: "not-json-at-all",
    },
  });
  await store.appendEvent({
    missionIdentifier: "mission-text",
    event: {
      eventIdentifier: "e3",
      kind: "tool-call",
      recordedAtIso: "2026-10-18T00:00:06.000Z",
      payloadJson: JSON.stringify({ outputText: "y".repeat(9_000) }),
    },
  });
}

describe("HISTORY-01-03：history 命令函数（进程内）", () => {
  it("① list：文本输出含 mission/段数/事件数，且有下一页提示", async () => {
    await seed();
    const exitCode = await executeHistoryListCommand({
      stateDirectory,
      pageSize: 1,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("运行历史：共 1 个 mission");
    expect(stdoutText).toContain("mission-text");
    expect(stdoutText).toContain("2 段");
    expect(stdoutText).toContain("3 条事件");
  });

  it("② list：空历史给出明确文案（不伪造条目），exit 0", async () => {
    const exitCode = await executeHistoryListCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("本地没有运行历史");
  });

  it("③ list：损坏条目在文本里显式标注（不静默丢弃）", async () => {
    const historyDirectory = path.join(stateDirectory, "run-history");
    await fs.mkdir(historyDirectory, { recursive: true });
    await fs.writeFile(path.join(historyDirectory, "m-bad.json"), "{broken", "utf8");

    const exitCode = await executeHistoryListCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("记录损坏");
    expect(stdoutText).toContain("m-bad");
  });

  it("④ list：状态目录不可读 ⇒ exit 1 且 stderr 有原因（不静默成功）", async () => {
    const filePath = path.join(stateDirectory, "run-history");
    await fs.writeFile(filePath, "not-a-directory", "utf8");

    const exitCode = await executeHistoryListCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(1);
    expect(stderrText).toContain("读取运行历史列表失败");
  });

  it("⑤ show：文本输出含标签、段号、未读 payload/截断标记与下一页游标", async () => {
    await seed();
    const exitCode = await executeHistoryShowCommand({
      stateDirectory,
      missionIdentifier: "mission-text",
      pageSize: 3,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("[工具调用]");
    expect(stdoutText).toContain("[恢复分界]");
    expect(stdoutText).toContain("该条详情不是合法 JSON");
    expect(stdoutText).toContain("详情过长，已截断");
    expect(stdoutText).toContain("提示：");
  });

  it("⑥ show：有下一页时打印 --cursor 提示（游标可继续）", async () => {
    await seed();
    const exitCode = await executeHistoryShowCommand({
      stateDirectory,
      missionIdentifier: "mission-text",
      pageSize: 1,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("下一页：--cursor 1");
  });

  it("⑦ show：损坏文件 ⇒ exit 1 且明确报「不可用」（不伪造完整）", async () => {
    const historyDirectory = path.join(stateDirectory, "run-history");
    await fs.mkdir(historyDirectory, { recursive: true });
    await fs.writeFile(path.join(historyDirectory, "m-bad.json"), "{broken", "utf8");

    const exitCode = await executeHistoryShowCommand({
      stateDirectory,
      missionIdentifier: "m-bad",
      isJsonOutput: false,
    });
    expect(exitCode).toBe(1);
    expect(stderrText).toContain("不可用");
  });

  it("⑧ show：读取抛错 ⇒ exit 1（不吞掉底层错误）", async () => {
    await fs.mkdir(path.join(stateDirectory, "run-history"), { recursive: true });
    // 让目标路径本身是目录 ⇒ readFile 抛 EISDIR（非 ENOENT 分支）
    await fs.mkdir(path.join(stateDirectory, "run-history", "m-dir.json"), { recursive: true });

    const exitCode = await executeHistoryShowCommand({
      stateDirectory,
      missionIdentifier: "m-dir",
      isJsonOutput: false,
    });
    expect(exitCode).toBe(1);
    expect(stderrText).toContain("读取运行历史失败");
  });

  it("⑨ resolveIncludedKinds：合法/未知/缺省三种情况", () => {
    expect(resolveIncludedKinds(undefined)).toEqual({
      kinds: null,
      unknownKind: null,
      hasUnknownKind: false,
    });
    expect(resolveIncludedKinds([])).toEqual({
      kinds: null,
      unknownKind: null,
      hasUnknownKind: false,
    });
    expect(resolveIncludedKinds(["tool-call", "model-note"])).toEqual({
      kinds: ["tool-call", "model-note"],
      unknownKind: null,
      hasUnknownKind: false,
    });
    expect(resolveIncludedKinds(["tool-call", "bogus"])).toEqual({
      kinds: null,
      unknownKind: "bogus",
      hasUnknownKind: true,
    });
  });

  it("⑩ JSON 输出：list 与 show 都把结构化结果写给 stdout（机器可解析）", async () => {
    await seed();

    expect(
      await executeHistoryListCommand({ stateDirectory, isJsonOutput: true }),
    ).toBe(0);
    const listPayload = JSON.parse(stdoutText) as { entries: Array<{ missionIdentifier: string }> };
    expect(listPayload.entries[0]?.missionIdentifier).toBe("mission-text");

    stdoutText = "";
    expect(
      await executeHistoryShowCommand({
        stateDirectory,
        missionIdentifier: "mission-text",
        isJsonOutput: true,
      }),
    ).toBe(0);
    const showPayload = JSON.parse(stdoutText) as { entries: Array<{ kindLabel: string }> };
    expect(showPayload.entries[0]?.kindLabel).toBe("工具调用");
  });

  it("⑪ show：该 mission 完全没有历史 ⇒ exit 1 并明确说「未找到」", async () => {
    const exitCode = await executeHistoryShowCommand({
      stateDirectory,
      missionIdentifier: "never-ran",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(1);
    expect(stderrText).toContain("未找到");
    expect(stdoutText).toBe("");
  });

  it("⑫ show：关闭总显示开关后文本仍提示「已隐藏、仍保存在本地」", async () => {
    await seed();
    const exitCode = await executeHistoryShowCommand({
      stateDirectory,
      missionIdentifier: "mission-text",
      displaySettings: { showRunHistory: false },
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("仍保存在本地");
    expect(stdoutText).toContain("本页显示 0 条");
  });
});
