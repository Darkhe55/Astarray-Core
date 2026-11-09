/**
 * HISTORY-01（2026-11-09）：**写入前脱敏**（卡内 §3 反例）。
 *
 * 修复的真实缺陷：工具输出与失败原因**原样落盘**，脱敏只在展示层
 * ⇒ "先保存再在 UI 遮挡"，密钥会先进入历史文件，任何读文件的人都能拿到。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunHistoryStore } from "../../../packages/core/src/orchestration/run-history-store.js";

let stateDirectory: string;
let store: RunHistoryStore;

const missionIdentifier = "mission-history-redaction";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-history-redact-"));
  store = new RunHistoryStore({ baseDirectory: stateDirectory });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 6 });
});

/** 读取该 mission 历史文件的**原始磁盘内容**（不经过任何展示层）。 */
async function readRawHistoryFile(): Promise<string> {
  const historyDirectoryPath = path.join(stateDirectory, "run-history");
  const fileNames = await fs.readdir(historyDirectoryPath);
  const target = fileNames.find((fileName) => fileName.endsWith(".json"));
  if (target === undefined) throw new Error("未找到运行历史文件");
  return await fs.readFile(path.join(historyDirectoryPath, target), "utf8");
}

describe("HISTORY-01 写入前脱敏", () => {
  it("工具输出里的 API key 不得原样落盘（磁盘上必须是脱敏值）", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    await store.recordToolCall({
      missionIdentifier,
      toolName: "readFile",
      outputText: `调用返回：Authorization: Bearer ${secret}`,
    });
    const rawHistory = await readRawHistoryFile();
    expect(rawHistory).not.toContain(secret);
    expect(rawHistory).toContain("[REDACTED]");
  });

  it("失败原因里的凭据同样不得原样落盘", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await store.recordToolFailure({
      missionIdentifier,
      toolName: "replaceFileContent",
      failureReason: `推送失败，token=${secret}`,
    });
    const rawHistory = await readRawHistoryFile();
    expect(rawHistory).not.toContain(secret);
    expect(rawHistory).toContain("[REDACTED]");
  });

  it("普通文本不受影响（脱敏不得破坏正常内容）", async () => {
    await store.recordToolCall({
      missionIdentifier,
      toolName: "readFile",
      outputText: "普通正文：实现完成并已通过测试",
    });
    const rawHistory = await readRawHistoryFile();
    expect(rawHistory).toContain("实现完成并已通过测试");
    expect(rawHistory).not.toContain("[REDACTED]");
  });

  it("直接 appendEvent 的载荷也走同一漏斗（不只 record* 入口）", async () => {
    const secret = "sk-lmnopqrstuvwxyz0987654321";
    await store.appendEvent({
      missionIdentifier,
      event: {
        eventIdentifier: "model-note:1",
        kind: "model-note",
        recordedAtIso: "2026-11-09T00:00:00.000Z",
        payloadJson: JSON.stringify({ noteText: `备注里带出 api_key=${secret}` }),
      },
    });
    const rawHistory = await readRawHistoryFile();
    expect(rawHistory).not.toContain(secret);
    expect(rawHistory).toContain("[REDACTED]");
  });

  it("脱敏后内容仍可被正常读回（结构未被破坏）", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    await store.recordToolCall({
      missionIdentifier,
      toolName: "readFile",
      outputText: `正文 + ${secret}`,
    });
    const readResult = await store.read(missionIdentifier);
    expect(readResult.kind).toBe("valid");
    if (readResult.kind !== "valid") return;
    const events = readResult.document.segments.flatMap((segment) => segment.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.payloadJson).toContain("[REDACTED]");
    expect(events[0]?.payloadJson).not.toContain(secret);
  });
});
