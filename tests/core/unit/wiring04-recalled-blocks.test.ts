/**
 * WIRING-04-05 补口（2026-11-25）：已回访块登记存储的反例。
 *
 * 纪律：只登记显式请求后取得的块；幂等不重复；按任务隔离；损坏视为未登记且不覆盖原文件。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecalledContextBlockStore } from "../../../packages/core/src/orchestration/recalled-context-block-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-recalled-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function block(overrides: Record<string, unknown> = {}) {
  return {
    missionIdentifier: "mission-1",
    agentInstanceIdentifier: "agent-1",
    missionTaskIdentifier: "T-1",
    contextNodeIdentifier: "node-1",
    sourceRevision: 2,
    text: "回访片段",
    registeredAtIso: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("WIRING-04-05 回访块登记", () => {
  it("① 登记后可被同一（mission/个体/任务）读回", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    expect(await store.register(block())).toEqual({ kind: "registered" });
    const listed = await store.listFor({
      missionIdentifier: "mission-1",
      agentInstanceIdentifier: "agent-1",
      missionTaskIdentifier: "T-1",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe("回访片段");
  });

  it("② 重复登记（同节点同 revision）⇒ duplicate，不追加", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    await store.register(block());
    expect(await store.register(block())).toEqual({ kind: "duplicate" });
    const listed = await store.listFor({
      missionIdentifier: "mission-1",
      agentInstanceIdentifier: "agent-1",
      missionTaskIdentifier: "T-1",
    });
    expect(listed).toHaveLength(1);
  });

  it("③ 换 revision 视为新块（旧版本不覆盖）", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    await store.register(block());
    await store.register(block({ sourceRevision: 3, text: "新版本片段" }));
    const listed = await store.listFor({
      missionIdentifier: "mission-1",
      agentInstanceIdentifier: "agent-1",
      missionTaskIdentifier: "T-1",
    });
    expect(listed).toHaveLength(2);
  });

  it("④ 按任务/个体隔离：别的任务读不到", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    await store.register(block());
    expect(
      await store.listFor({
        missionIdentifier: "mission-1",
        agentInstanceIdentifier: "agent-2",
        missionTaskIdentifier: "T-1",
      }),
    ).toHaveLength(0);
    expect(
      await store.listFor({
        missionIdentifier: "mission-1",
        agentInstanceIdentifier: "agent-1",
        missionTaskIdentifier: "T-2",
      }),
    ).toHaveLength(0);
  });

  it("⑤ 非法输入拒绝（空正文、revision=0、缺任务）", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    expect(await store.register(block({ text: "  " }))).toMatchObject({ kind: "rejected" });
    expect(await store.register(block({ sourceRevision: 0 }))).toMatchObject({
      kind: "rejected",
    });
    expect(await store.register(block({ missionTaskIdentifier: "" }))).toMatchObject({
      kind: "rejected",
    });
  });

  it("⑥ 文件损坏 ⇒ 视为未登记，且不覆盖原文件", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    await store.register(block());
    const filePath = path.join(baseDirectory, "recalled-context-blocks.json");
    await fs.writeFile(filePath, "{ 损坏", "utf8");
    expect(
      await store.listFor({
        missionIdentifier: "mission-1",
        agentInstanceIdentifier: "agent-1",
        missionTaskIdentifier: "T-1",
      }),
    ).toHaveLength(0);
    expect(await fs.readFile(filePath, "utf8")).toBe("{ 损坏");
  });
});
