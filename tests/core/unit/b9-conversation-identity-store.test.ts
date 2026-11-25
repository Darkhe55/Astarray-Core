/**
 * B9（2026-11-25）：会话身份映射存储（派生标识拒绝、幂等、关闭后拒绝、损坏 fail-closed）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConversationIdentityStore,
  isDerivedProcessOrMissionIdentifier,
} from "../../../packages/core/src/orchestration/conversation-identity-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-conv-id-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function createStore(retained = 3) {
  return new ConversationIdentityStore({
    baseDirectory,
    maximumRetainedRunCountPerConversation: retained,
  });
}

describe("B9：会话身份映射存储", () => {
  it("① 派生标识识别：mission/pid/process/host 前缀都算派生", () => {
    expect(isDerivedProcessOrMissionIdentifier("mission-abc")).toBe(true);
    expect(isDerivedProcessOrMissionIdentifier("mission:abc")).toBe(true);
    expect(isDerivedProcessOrMissionIdentifier("PID-123")).toBe(true);
    expect(isDerivedProcessOrMissionIdentifier("process-1")).toBe(true);
    expect(isDerivedProcessOrMissionIdentifier("host-abc")).toBe(true);
    expect(isDerivedProcessOrMissionIdentifier("conversation-abc")).toBe(false);
  });

  it("② 显式开启会话：同 ID 同参数幂等；不同主个体 ⇒ 冲突", async () => {
    const store = createStore();
    const first = await store.openConversation({
      projectIdentifier: "project-1",
      conversationIdentifier: "conv-1",
      mainAgentInstanceIdentifier: "agent-1",
    } as never);
    expect(first.conversationIdentifier).toBe("conv-1");
    expect(first.mainAgentInstanceIdentifier).toBe("agent-1");

    const again = await store.openConversation({
      projectIdentifier: "project-1",
      conversationIdentifier: "conv-1",
      mainAgentInstanceIdentifier: "agent-1",
    } as never);
    expect(again.mainAgentInstanceIdentifier).toBe("agent-1");

    const conflict = await store
      .openConversation({
        projectIdentifier: "project-1",
        conversationIdentifier: "conv-1",
        mainAgentInstanceIdentifier: "agent-2",
      } as never)
      .catch((error: Error) => error);
    expect(conflict).toBeInstanceOf(Error);
  });

  it("③ 会话不存在/已关闭 ⇒ beginRun 明确拒绝", async () => {
    const store = createStore();
    await expect(
      store.beginRun({ conversationIdentifier: "conv-missing" } as never),
    ).rejects.toMatchObject({ errorCode: "conversation-identity-not-found" });

    await store.openConversation({
      projectIdentifier: "project-1",
      conversationIdentifier: "conv-2",
      mainAgentInstanceIdentifier: "agent-1",
    } as never);
    await store.closeConversation("conv-2");
    await expect(
      store.beginRun({ conversationIdentifier: "conv-2" } as never),
    ).rejects.toMatchObject({ errorCode: "conversation-identity-closed" });
  });

  it("④ 同 mission 重放 ⇒ 返回既有 run（不重复登记）", async () => {
    const store = createStore();
    await store.openConversation({
      projectIdentifier: "project-1",
      conversationIdentifier: "conv-3",
      mainAgentInstanceIdentifier: "agent-1",
    } as never);
    const first = await store.beginRun({
      conversationIdentifier: "conv-3",
      missionIdentifier: "mission-run-1",
    } as never);
    const replay = await store.beginRun({
      conversationIdentifier: "conv-3",
      missionIdentifier: "mission-run-1",
    } as never);
    expect(replay.runIdentifier).toBe(first.runIdentifier);
  });

  it("⑤ 运行记录有界：超出上限时保留最近并累计 droppedRunCount", async () => {
    const store = createStore(2);
    await store.openConversation({
      projectIdentifier: "project-1",
      conversationIdentifier: "conv-4",
      mainAgentInstanceIdentifier: "agent-1",
    } as never);
    for (let index = 1; index <= 4; index += 1) {
      await store.beginRun({
        conversationIdentifier: "conv-4",
        missionIdentifier: "mission-run-" + String(index),
      } as never);
    }
    const record = await store.getConversation("conv-4");
    expect(record?.runs.length).toBeLessThanOrEqual(2);
    expect(record?.droppedRunCount).toBeGreaterThanOrEqual(2);
  });

  it("⑥ 文档损坏 ⇒ journal-corrupted（不静默覆盖）", async () => {
    await fs.mkdir(path.join(baseDirectory, "conversation-identity"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "conversation-identity", "conversations.json"),
      JSON.stringify({ schemaVersion: 999 }),
      "utf8",
    );
    const store = createStore();
    await expect(store.readDocument()).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });
});
