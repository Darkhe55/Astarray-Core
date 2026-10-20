/**
 * 一次性（不入库）：SUM-01-04 剩余 —— `summary publish` 的 CLI 反例。
 *
 * 覆盖：载荷与来源种类不匹配必须拒绝、非法条目逐条指出（不静默丢弃）、
 * 空来源不发布空清单（退出码 1）、三类来源都能经公开 CLI 发布并可被 list/show 读到。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeSummaryListCommand,
  executeSummaryPublishCommand,
  executeSummaryShowCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let payloadDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-summary-publish-"));
  payloadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-summary-payload-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
  await fs.rm(payloadDirectory, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { getOutput: () => chunks.join("") };
}

function captureStderr(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { getOutput: () => chunks.join("") };
}

async function writePayload(fileName: string, payload: unknown): Promise<string> {
  const filePath = path.join(payloadDirectory, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

const conversationTurns = [
  {
    turnIdentifier: "turn-1",
    speaker: "user",
    text: "帮我看一下安装步骤",
    recordedAtIso: "2026-10-20T10:00:00.000Z",
  },
  {
    turnIdentifier: "turn-2",
    speaker: "agent",
    text: "安装步骤缺少 Node 版本要求",
    recordedAtIso: "2026-10-20T10:00:05.000Z",
  },
];

describe("SUM-01-04 摘要发布 CLI（conversation / report / deferred-file）", () => {
  it("① 会话来源可经 CLI 发布，输出含 sourceKind 与清单版本", async () => {
    const payloadPath = await writePayload("turns.json", { turns: conversationTurns });
    const capture = captureStdout();
    const exitCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "conversation",
      sourceIdentifier: "session-1",
      payloadPath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.getOutput()) as {
      status: string;
      sourceKind: string;
      entryCount: number;
      manifestRevision: number;
    };
    expect(payload.status).toBe("ok");
    expect(payload.sourceKind).toBe("conversation");
    expect(payload.entryCount).toBeGreaterThan(0);
    expect(payload.manifestRevision).toBeGreaterThan(0);
  });

  it("② 载荷与来源种类不匹配 ⇒ 拒绝（usage error，不按错适配器解释）", async () => {
    const payloadPath = await writePayload("mismatch.json", { reports: [] });
    const stderr = captureStderr();
    const exitCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "conversation",
      sourceIdentifier: "session-1",
      payloadPath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toContain("payload-kind-mismatch");
  });

  it("③ 非法条目 ⇒ 指出第几项（不静默丢弃）", async () => {
    const payloadPath = await writePayload("invalid.json", {
      turns: [conversationTurns[0], { turnIdentifier: "turn-2" }],
    });
    const stderr = captureStderr();
    const exitCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "conversation",
      sourceIdentifier: "session-1",
      payloadPath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toContain("turns[1]");
  });

  it("④ 空来源 ⇒ no-history 且退出码 1（不发布空清单冒充成功）", async () => {
    const payloadPath = await writePayload("empty.json", { turns: [] });
    const capture = captureStdout();
    const exitCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "conversation",
      sourceIdentifier: "session-empty",
      payloadPath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(capture.getOutput())).toMatchObject({ status: "no-history" });
  });

  it("⑤ 报告来源发布后，list 能列出该来源", async () => {
    const payloadPath = await writePayload("reports.json", {
      reports: [
        {
          reportIdentifier: "report-1",
          taskIdentifier: "task-1",
          summaryText: "验收通过",
          recordedAtIso: "2026-10-20T11:00:00.000Z",
        },
      ],
    });
    const publishCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "report",
      sourceIdentifier: "report-set-1",
      payloadPath,
      isJsonOutput: true,
    });
    expect(publishCode).toBe(0);

    const listCapture = captureStdout();
    const listCode = await executeSummaryListCommand({ stateDirectory, isJsonOutput: true });
    expect(listCode).toBe(0);
    const listPayload = JSON.parse(listCapture.getOutput()) as {
      sources: Array<{ sourceKind: string; sourceIdentifier: string }>;
    };
    expect(
      listPayload.sources.some(
        (source) => source.sourceKind === "report" && source.sourceIdentifier === "report-set-1",
      ),
    ).toBe(true);
  });

  it("⑥ 延后文件来源发布后，show 能展开该来源", async () => {
    const payloadPath = await writePayload("deferred.json", {
      deferredFiles: [
        {
          fileIdentifier: "file-1",
          filePath: "docs/notes.md",
          lineRangeStart: 10,
          lineRangeEnd: 20,
          excerptText: "这一段是延后读取的内容",
          recordedAtIso: "2026-10-20T12:00:00.000Z",
        },
      ],
    });
    const publishCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "deferred-file",
      sourceIdentifier: "deferred-queue-1",
      payloadPath,
      isJsonOutput: true,
    });
    expect(publishCode).toBe(0);

    const showCapture = captureStdout();
    const showCode = await executeSummaryShowCommand({
      stateDirectory,
      sourceIdentifier: "deferred-queue-1",
      sourceKind: "deferred-file",
      detailLevel: "summary",
      pageSize: 20,
      chunkIdentifier: undefined,
      maximumReturnUnitCount: undefined,
      isJsonOutput: true,
    });
    const showPayload = JSON.parse(showCapture.getOutput()) as {
      status?: string;
      view?: { sourceIdentifier?: string };
    };
    expect(showCode, JSON.stringify(showPayload)).toBe(0);
    expect(showPayload.view?.sourceIdentifier).toBe("deferred-queue-1");
  });

  it("⑦ payload 文件不存在 ⇒ usage error（不静默当成空来源）", async () => {
    const stderr = captureStderr();
    const exitCode = await executeSummaryPublishCommand({
      stateDirectory,
      sourceKind: "conversation",
      sourceIdentifier: "session-1",
      payloadPath: path.join(payloadDirectory, "missing.json"),
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toContain("payload 读取失败");
  });
});



