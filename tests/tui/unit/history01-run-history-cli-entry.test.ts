/**
 * HISTORY-01-03 的 **CLI 入口反例**（2026-10-18）。
 *
 * 卡内 §4/§5 要求「CLI 提供分页列表/单事件详情及机器可读格式，复用同一只读查询服务」，
 * §3 要求「查看任意历史绝不触发工具重放」。本文件钉住 argv 级闭环：
 *  - `history list --json` 能看到真实落盘的 mission；
 *  - `history show --json` 一页时间线含工具调用与失败原因，游标能翻页；
 *  - 默认不显示过程说明，但**如实**给出「该运行未提供过程说明」/「已隐藏」；
 *  - `--show-process-explanations` 能看到 model-note；
 *  - 没有历史 ⇒ **非 0 退出**（不伪造一条空历史冒充跑过）；
 *  - 未知 `--kind` ⇒ 用法错误（exit 2）；
 *  - ANSI/控制序列不出现在 stdout（终端注入防线）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/*
 * 超时预算（2026-10-13 约定）：本文件含**真实 CLI 子进程**用例，
 * 全量门禁并发下 5s 默认上限不够；断言一律不放宽。
 */
vi.setConfig({ testTimeout: 60_000 });

import { RunHistoryStore } from "../../../packages/core/src/orchestration/run-history-store.js";

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let workingDirectory: string;

/** 运行真实构建产物 `dist/cli.js`（改 src 后必须先 npm run build）。 */
async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  const childProcess = spawn(process.execPath, [cliEntryPath, ...args], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdoutText = "";
  let stderrText = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => (stdoutText += chunk));
  childProcess.stderr.on("data", (chunk: string) => (stderrText += chunk));
  const exitCode = await new Promise<number>((resolve) => {
    childProcess.on("close", (code: number | null) => resolve(code ?? 1));
  });
  return { exitCode, stdoutText, stderrText };
}

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-history01-cli-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 在 CLI 默认状态目录（`<cwd>/.astarray`）写一份真实运行历史。 */
async function seedRunHistory(): Promise<void> {
  const store = new RunHistoryStore({
    baseDirectory: path.join(workingDirectory, ".astarray"),
  });
  await store.recordToolCall({
    missionIdentifier: "mission-cli",
    toolName: "readFile",
    outputText: "file-content",
    recordedAtIso: "2026-10-18T00:00:01.000Z",
  });
  await store.recordToolFailure({
    missionIdentifier: "mission-cli",
    toolName: "writeFile",
    failureReason: "permission-denied",
    recordedAtIso: "2026-10-18T00:00:02.000Z",
  });
  await store.appendEvent({
    missionIdentifier: "mission-cli",
    event: {
      eventIdentifier: "note-1",
      kind: "model-note",
      recordedAtIso: "2026-10-18T00:00:03.000Z",
      payloadJson: JSON.stringify({ note: "先读后写" }),
    },
  });
  await store.appendEvent({
    missionIdentifier: "mission-cli",
    event: {
      eventIdentifier: "resume-1",
      kind: "resume-boundary",
      recordedAtIso: "2026-10-18T00:10:00.000Z",
      payloadJson: JSON.stringify({ checkpoint: "cp-1" }),
    },
  });
}

describe("HISTORY-01-03：运行历史 CLI 入口（只读、分页、显示开关）", () => {
  it("① list --json：列出真实落盘的 mission（含段数与事件数），exit 0", async () => {
    await seedRunHistory();
    const { exitCode, stdoutText } = await runCli(["history", "list", "--json"]);
    expect(exitCode).toBe(0);

    const payload = JSON.parse(stdoutText) as {
      entries: Array<{
        missionIdentifier: string;
        segmentCount: number;
        eventCount: number;
        isCorrupted: boolean;
      }>;
      totalMissionCount: number;
    };
    expect(payload.totalMissionCount).toBe(1);
    expect(payload.entries[0]?.missionIdentifier).toBe("mission-cli");
    expect(payload.entries[0]?.segmentCount).toBe(2);
    expect(payload.entries[0]?.eventCount).toBe(4);
    expect(payload.entries[0]?.isCorrupted).toBe(false);
  });

  it("② show --json：默认隐藏过程说明但**如实说明**；游标可翻页且不重复", async () => {
    await seedRunHistory();

    const firstPage = await runCli([
      "history",
      "show",
      "--mission",
      "mission-cli",
      "--page-size",
      "2",
      "--json",
    ]);
    expect(firstPage.exitCode).toBe(0);
    const firstPayload = JSON.parse(firstPage.stdoutText) as {
      entries: Array<{ sequenceNumber: number; kind: string; detailText: string }>;
      notice: string | null;
      storedEventCount: number;
      hiddenEventCount: number;
      nextCursor: number | null;
    };
    expect(firstPayload.notice).toBe("过程说明按显示设置隐藏（仍保存在本地，不会被删除）");
    expect(firstPayload.storedEventCount).toBe(4);
    expect(firstPayload.hiddenEventCount).toBe(1);
    expect(firstPayload.entries.map((entry) => entry.kind)).toEqual([
      "tool-call",
      "tool-failure",
    ]);
    expect(firstPayload.entries[1]?.detailText).toContain("permission-denied");
    expect(firstPayload.nextCursor).toBe(2);

    const secondPage = await runCli([
      "history",
      "show",
      "--mission",
      "mission-cli",
      "--page-size",
      "2",
      "--cursor",
      "2",
      "--json",
    ]);
    expect(secondPage.exitCode).toBe(0);
    const secondPayload = JSON.parse(secondPage.stdoutText) as {
      entries: Array<{ sequenceNumber: number; kind: string }>;
      nextCursor: number | null;
    };
    expect(secondPayload.entries.map((entry) => entry.sequenceNumber)).toEqual([4]);
    expect(secondPayload.entries.map((entry) => entry.kind)).toEqual(["resume-boundary"]);
    expect(secondPayload.nextCursor).toBeNull();
  });

  it("③ --show-process-explanations 之后仍能看到过程说明与分界", async () => {
    await seedRunHistory();
    const { exitCode, stdoutText } = await runCli([
      "history",
      "show",
      "--mission",
      "mission-cli",
      "--show-process-explanations",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      entries: Array<{ kind: string }>;
      notice: string | null;
    };
    expect(payload.notice).toBeNull();
    expect(payload.entries.map((entry) => entry.kind)).toEqual([
      "tool-call",
      "tool-failure",
      "model-note",
      "resume-boundary",
    ]);
  });

  it("④ 没有该 mission 的历史 ⇒ exit 1（不伪造空历史）", async () => {
    const { exitCode, stderrText } = await runCli([
      "history",
      "show",
      "--mission",
      "does-not-exist",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    expect(stderrText).toContain("未找到");
  });

  it("⑤ 未知 --kind ⇒ 用法错误 exit 2（不静默忽略过滤条件）", async () => {
    await seedRunHistory();
    const { exitCode, stderrText } = await runCli([
      "history",
      "show",
      "--mission",
      "mission-cli",
      "--kind",
      "not-a-kind",
      "--json",
    ]);
    expect(exitCode).toBe(2);
    expect(stderrText).toContain("未知的事件种类");
  });

  it("⑦ --search：只返回命中事件，并回显检索词与命中数", async () => {
    await seedRunHistory();
    const { exitCode, stdoutText } = await runCli([
      "history",
      "show",
      "--mission",
      "mission-cli",
      "--search",
      "permission-denied",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      searchQuery: string | null;
      searchMatchCount: number | null;
      entries: Array<{ kind: string; evidenceAnchor: string }>;
    };
    expect(payload.searchQuery).toBe("permission-denied");
    expect(payload.searchMatchCount).toBe(1);
    expect(payload.entries.map((entry) => entry.kind)).toEqual(["tool-failure"]);
    expect(payload.entries[0]?.evidenceAnchor).toMatch(/^run-history:mission-cli#\d+$/);

    const textOutcome = await runCli([
      "history",
      "show",
      "--mission",
      "mission-cli",
      "--search",
      "permission-denied",
    ]);
    expect(textOutcome.exitCode).toBe(0);
    expect(textOutcome.stdoutText).toContain("命中 1 条");
  });

  it("⑥ 文本输出与 JSON 都不含 ANSI/控制序列（终端注入防线）", async () => {
    const store = new RunHistoryStore({
      baseDirectory: path.join(workingDirectory, ".astarray"),
    });
    await store.appendEvent({
      missionIdentifier: "mission-injection",
      event: {
        eventIdentifier: "escape-1",
        kind: "tool-call",
        recordedAtIso: "2026-10-18T00:00:00.000Z",
        payloadJson: JSON.stringify({ outputText: "\u001B[2J\u001B[31mcleared\u001B[0m" }),
      },
    });

    const jsonOutcome = await runCli([
      "history",
      "show",
      "--mission",
      "mission-injection",
      "--json",
    ]);
    expect(jsonOutcome.exitCode).toBe(0);
    expect(jsonOutcome.stdoutText).not.toContain("\u001B");

    const textOutcome = await runCli(["history", "show", "--mission", "mission-injection"]);
    expect(textOutcome.exitCode).toBe(0);
    expect(textOutcome.stdoutText).not.toContain("\u001B");
    expect(textOutcome.stdoutText).toContain("控制序列已移除");
  });
});
