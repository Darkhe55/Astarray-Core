/**
 * COORD-05 05-03（2026-11-22）：用户待决记录。
 *
 * 钉住四件事：
 * 1. 读状态区分：首次无文件 / 损坏 / 暂时不可读；
 * 2. 按（项目, 原请求）幂等登记：重试只生成一条；
 * 3. 损坏时破坏性写入被拒绝（不覆盖用户问题）；
 * 4. 跨实例并发登记/答复不丢更新（文件锁内读-改-写）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserClarificationStore } from "../../../packages/core/src/orchestration/user-clarification.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function store(): UserClarificationStore {
  return new UserClarificationStore({ baseDirectory });
}

const candidates = [
  { candidateIdentifier: "c1", label: "方案 A", value: "a", isRecommended: true },
  { candidateIdentifier: "c2", label: "方案 B", value: "b" },
];

describe("COORD-05 05-03：用户待决记录", () => {
  it("① 读状态：首次无文件 ⇒ missing", async () => {
    expect(await store().readState()).toEqual({ kind: "missing" });
  });

  it("② 读状态：损坏 ⇒ corrupted，登记拒绝覆盖", async () => {
    await fs.mkdir(path.join(baseDirectory, "clarifications"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "clarifications", "requests.json"),
      "{not-json",
      "utf8",
    );
    expect((await store().readState()).kind).toBe("corrupted");
    await expect(
      store().register({
        ownerAgentInstanceId: "agent-a",
        taskIdentifier: "T-1",
        projectIdentifier: "p1",
        questionText: "要选哪个方案？",
        candidates,
        createdAtIso: "2026-11-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(/损坏/);
  });

  it("③ 读状态：路径被目录占用 ⇒ unreadable，登记拒绝写入", async () => {
    await fs.mkdir(path.join(baseDirectory, "clarifications", "requests.json"), {
      recursive: true,
    });
    const state = await store().readState();
    expect(state.kind).toBe("unreadable");
    await expect(
      store().register({
        ownerAgentInstanceId: "agent-a",
        taskIdentifier: "T-1",
        projectIdentifier: "p1",
        questionText: "要选哪个方案？",
        candidates,
        createdAtIso: "2026-11-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(/不可读/);
  });

  it("④ 按（项目, 原请求）幂等：重试只生成一条且保留原记录", async () => {
    const first = await store().register({
      ownerAgentInstanceId: "agent-a",
      taskIdentifier: "T-1",
      projectIdentifier: "p1",
      questionText: "要选哪个方案？",
      candidates,
      createdAtIso: "2026-11-22T00:00:00.000Z",
      sourceRequestIdentifier: "req-1",
      impactSummary: "导出步骤受阻",
      recommendedReason: "方案 A 与现有约定一致",
      blockedStepIdentifiers: ["step-export"],
    });
    const second = await store().register({
      ownerAgentInstanceId: "agent-a",
      taskIdentifier: "T-1",
      projectIdentifier: "p1",
      questionText: "要选哪个方案？（重试）",
      candidates,
      createdAtIso: "2026-11-22T00:00:01.000Z",
      sourceRequestIdentifier: "req-1",
    });
    expect(second.clarificationIdentifier).toBe(first.clarificationIdentifier);
    const pending = await store().listPending("p1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sourceRequestIdentifier).toBe("req-1");
    expect(pending[0]?.impactSummary).toBe("导出步骤受阻");
    expect(pending[0]?.blockedStepIdentifiers).toEqual(["step-export"]);

    /** 不同项目同名原请求 ⇒ 另一条待决事项。 */
    await store().register({
      ownerAgentInstanceId: "agent-a",
      taskIdentifier: "T-1",
      projectIdentifier: "p2",
      questionText: "要选哪个方案？",
      candidates,
      createdAtIso: "2026-11-22T00:00:02.000Z",
      sourceRequestIdentifier: "req-1",
    });
    expect(await store().listPending("p2")).toHaveLength(1);
  });

  it("⑤ 跨实例并发登记 40 条 ⇒ 40 条全部保留（不丢更新）", async () => {
    const stores = [store(), store()];
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        stores[index % 2]!.register({
          ownerAgentInstanceId: "agent-a",
          taskIdentifier: "T-" + String(index),
          projectIdentifier: "p1",
          questionText: "问题 " + String(index),
          candidates,
          createdAtIso: "2026-11-22T00:00:00.000Z",
        }),
      ),
    );
    const pending = await store().listPending("p1");
    expect(pending).toHaveLength(40);
  });

  it("⑥ 并发登记与答复不互相覆盖", async () => {
    const first = await store().register({
      ownerAgentInstanceId: "agent-a",
      taskIdentifier: "T-1",
      projectIdentifier: "p1",
      questionText: "先回答这条",
      candidates,
      createdAtIso: "2026-11-22T00:00:00.000Z",
    });
    const stores = [store(), store()];
    await Promise.all([
      stores[0]!.answer({
        clarificationIdentifier: first.clarificationIdentifier,
        answer: "a",
        answeredAtIso: "2026-11-22T00:00:05.000Z",
      }),
      ...Array.from({ length: 10 }, (_, index) =>
        stores[1]!.register({
          ownerAgentInstanceId: "agent-a",
          taskIdentifier: "T-new-" + String(index),
          projectIdentifier: "p1",
          questionText: "并发问题 " + String(index),
          candidates,
          createdAtIso: "2026-11-22T00:00:01.000Z",
        }),
      ),
    ]);
    const pending = await store().listPending("p1");
    expect(pending).toHaveLength(10);
    const state = await store().readState();
    expect(state.kind).toBe("valid");
    if (state.kind !== "valid") return;
    const answered = state.document.requests.find(
      (request) => request.clarificationIdentifier === first.clarificationIdentifier,
    );
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toBe("a");
  });

  it("⑦ 旧记录（无新字段）仍可读、可答复", async () => {
    await fs.mkdir(path.join(baseDirectory, "clarifications"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "clarifications", "requests.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        requests: [
          {
            clarificationIdentifier: "clarify-legacy",
            ownerAgentInstanceId: "agent-a",
            taskIdentifier: "T-legacy",
            projectIdentifier: "p1",
            questionText: "旧问题",
            candidates: [],
            allowFreeformInput: true,
            createdAtIso: "2026-11-01T00:00:00.000Z",
            status: "pending",
            answer: null,
            answeredAtIso: null,
          },
        ],
      }),
      "utf8",
    );
    expect(await store().listPending("p1")).toHaveLength(1);
    const answered = await store().answer({
      clarificationIdentifier: "clarify-legacy",
      answer: "可以",
      answeredAtIso: "2026-11-22T00:00:00.000Z",
    });
    expect(answered.status).toBe("answered");
    expect(await store().listPending("p1")).toHaveLength(0);
  });
});
