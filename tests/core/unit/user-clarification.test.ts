import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UserClarificationStore } from "../../../packages/core/src/orchestration/user-clarification.js";

const directories: string[] = [];
async function base(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-clarify-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const candidates = [
  { candidateIdentifier: "a", label: "方案 A", value: "a", isRecommended: true },
  { candidateIdentifier: "b", label: "方案 B", value: "b" },
];

describe("UserClarificationStore", () => {
  it("① 登记候选问题 + 候选回答；重复回答拒绝", async () => {
    const baseDirectory = await base();
    const store = new UserClarificationStore({ baseDirectory });
    const request = await store.register({
      ownerAgentInstanceId: "agent-1",
      taskIdentifier: "T-1",
      projectIdentifier: "p1",
      questionText: "选哪个方案？",
      candidates,
      createdAtIso: "2026-10-25T00:00:00.000Z",
    });
    expect(await store.listPending("p1")).toHaveLength(1);
    const answered = await store.answer({
      clarificationIdentifier: request.clarificationIdentifier,
      answer: "a",
      answeredAtIso: "2026-10-25T00:01:00.000Z",
    });
    expect(answered.status).toBe("answered");
    expect(await store.listPending("p1")).toHaveLength(0);
    await expect(
      store.answer({
        clarificationIdentifier: request.clarificationIdentifier,
        answer: "b",
        answeredAtIso: "2026-10-25T00:02:00.000Z",
      }),
    ).rejects.toThrow("已回答");
  });

  it("② 只接受候选（allowFreeformInput=false）时自由输入被拒；重复候选标识被拒", async () => {
    const baseDirectory = await base();
    const store = new UserClarificationStore({ baseDirectory });
    const request = await store.register({
      ownerAgentInstanceId: "agent-1",
      taskIdentifier: "T-1",
      projectIdentifier: "p1",
      questionText: "选哪个？",
      candidates,
      allowFreeformInput: false,
      createdAtIso: "2026-10-25T00:00:00.000Z",
    });
    await expect(
      store.answer({
        clarificationIdentifier: request.clarificationIdentifier,
        answer: "free text",
        answeredAtIso: "2026-10-25T00:01:00.000Z",
      }),
    ).rejects.toThrow("只接受候选项");
    await expect(
      store.register({
        ownerAgentInstanceId: "agent-1",
        taskIdentifier: "T-2",
        projectIdentifier: "p1",
        questionText: "重复候选？",
        candidates: [candidates[0]!, candidates[0]!],
        createdAtIso: "2026-10-25T00:00:00.000Z",
      }),
    ).rejects.toThrow("候选标识重复");
  });
});
