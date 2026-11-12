/**
 * 会话身份存储（此前 `tests/` 零引用）：**稳定会话 → 主个体 → 运行**。
 *
 * 四条硬约束逐条锁死：
 * ① 会话标识不得由宿主进程/任务派生；② 同会话换项目 ⇒ 冲突，绝不静默改绑；
 * ③ 已关闭会话不得继续追加运行；④ 运行与 mission 分开（同 mission 重放返回同一 run）。
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
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-identity-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore() {
  return new ConversationIdentityStore({ baseDirectory } as never);
}

describe("派生标识判定", () => {
  it("① mission/pid/process/host 派生形态一律识别为派生", () => {
    for (const derived of ["mission-abc", "mission:abc", "pid-1", "pid:2", "process-x", "host:y"]) {
      expect(isDerivedProcessOrMissionIdentifier(derived)).toBe(true);
    }
    expect(isDerivedProcessOrMissionIdentifier("conversation-1")).toBe(false);
  });
});

describe("会话身份", () => {
  it("② 用派生标识开会话 ⇒ 拒绝", async () => {
    const store = buildStore();
    await expect(
      store.openConversation({
        projectIdentifier: "project-alpha",
        conversationIdentifier: "mission-abc",
      }),
    ).rejects.toThrow();
  });

  it("③ 新建会话 ⇒ active、记录项目与主个体", async () => {
    const store = buildStore();
    const conversation = await store.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    expect(conversation.status).toBe("active");
    expect(conversation.projectIdentifier).toBe("project-alpha");
    expect(conversation.mainAgentInstanceIdentifier.length).toBeGreaterThan(0);
  });

  it("④ 同 ID 同参数重复开启 ⇒ 幂等（同一记录）", async () => {
    const store = buildStore();
    const first = await store.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    const second = await store.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    expect(second.conversationIdentifier).toBe(first.conversationIdentifier);
    expect(second.mainAgentInstanceIdentifier).toBe(first.mainAgentInstanceIdentifier);
    expect((await store.readDocument()).conversations["conversation-1"]).toBeDefined();
  });

  it("⑤ 同 ID 换项目 ⇒ 冲突，绝不静默改绑", async () => {
    const store = buildStore();
    await store.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    await expect(
      store.openConversation({
        projectIdentifier: "project-beta",
        conversationIdentifier: "conversation-1",
      }),
    ).rejects.toMatchObject({ errorCode: "conversation-identity-conflict" });
  });

  it("⑥ 已关闭会话不得继续追加运行", async () => {
    const store = buildStore();
    await store.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    await store.closeConversation("conversation-1");
    await expect(
      store.beginRun({ conversationIdentifier: "conversation-1" }),
    ).rejects.toMatchObject({ errorCode: "conversation-identity-closed" });
  });

  it("⑦ 同 mission 重放 ⇒ 返回同一 run（不重复登记）", async () => {
    const store = buildStore();
    await store.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    const first = await store.beginRun({
      conversationIdentifier: "conversation-1",
      missionIdentifier: "mission-1",
      userMessageReference: "user-message-1",
    });
    const replay = await store.beginRun({
      conversationIdentifier: "conversation-1",
      missionIdentifier: "mission-1",
      userMessageReference: "user-message-1",
    });
    expect(replay.runIdentifier).toBe(first.runIdentifier);
    const conversation = await store.getConversation("conversation-1");
    expect(conversation?.runs ?? []).toHaveLength(1);
    expect(conversation?.runs?.[0]?.userMessageReference).toBe("user-message-1");
  });

  it("⑧ 重启（新实例同目录）⇒ 仍是同一会话与同一主个体", async () => {
    const first = buildStore();
    const created = await first.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier: "conversation-1",
    });
    const restarted = buildStore();
    const resolved = await restarted.resolveActiveConversationForProject("project-alpha");
    expect(resolved?.conversationIdentifier).toBe("conversation-1");
    expect(resolved?.mainAgentInstanceIdentifier).toBe(created.mainAgentInstanceIdentifier);
  });
});
