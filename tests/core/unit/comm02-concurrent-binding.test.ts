/**
 * COMM-01-02 并发绑定与恢复反例（2026-10-23）。
 *
 * 卡内点名"并发绑定与恢复反例"。同时补一个与 mailbox 同类的风险：
 * `AgentCreationRegistry` 的注册是"改内存 → 整文件原子写"，并发注册若交错落盘，
 * 后写者可能用旧快照覆盖（丢登记）。这里用并发注册 + **重启后读回** 来钉住。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentAddressGuard,
  AgentCreationRegistry,
} from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";

const temporaryDirectories: string[] = [];

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-comm-binding-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("COMM-01-02 并发绑定与恢复", () => {
  it("① 并发登记 10 个个体 ⇒ 重启后 10 个都还在（不丢登记）", async () => {
    const stateDirectory = await createStateDirectory();
    const registry = new AgentCreationRegistry({ stateDirectory });
    await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        registry.registerCreatedAgent({
          agentInstanceId: `agent-${String(index)}`,
          createdByAgentInstanceId: index === 0 ? null : "agent-0",
        }),
      ),
    );
    // 重启：新实例从磁盘读回
    const reloaded = new AgentCreationRegistry({ stateDirectory });
    const records = await Promise.all(
      Array.from({ length: 10 }, (_value, index) => reloaded.getRecord(`agent-${String(index)}`)),
    );
    expect(records.filter((record) => record !== null)).toHaveLength(10);
  });

  it("② 同 id 重复登记 ⇒ 首次为准（不覆盖创建者，幂等）", async () => {
    const stateDirectory = await createStateDirectory();
    const registry = new AgentCreationRegistry({ stateDirectory });
    const first = await registry.registerCreatedAgent({
      agentInstanceId: "agent-x",
      createdByAgentInstanceId: "agent-parent-1",
    });
    const second = await registry.registerCreatedAgent({
      agentInstanceId: "agent-x",
      createdByAgentInstanceId: "agent-parent-2",
    });
    expect(second.createdByAgentInstanceId).toBe("agent-parent-1");
    expect(second.createdAtIso).toBe(first.createdAtIso);
  });

  it("③ 并发登记两个不同创建者时，自己的创建者事实不被覆盖", async () => {
    const stateDirectory = await createStateDirectory();
    const registry = new AgentCreationRegistry({ stateDirectory });
    await Promise.all([
      registry.registerCreatedAgent({ agentInstanceId: "agent-a", createdByAgentInstanceId: "parent-1" }),
      registry.registerCreatedAgent({ agentInstanceId: "agent-b", createdByAgentInstanceId: "parent-2" }),
    ]);
    const reloaded = new AgentCreationRegistry({ stateDirectory });
    expect((await reloaded.getRecord("agent-a"))?.createdByAgentInstanceId).toBe("parent-1");
    expect((await reloaded.getRecord("agent-b"))?.createdByAgentInstanceId).toBe("parent-2");
  });

  it("④ 回收后重启：历史保留但不可投递（不复活）", async () => {
    const stateDirectory = await createStateDirectory();
    const registry = new AgentCreationRegistry({ stateDirectory });
    await registry.registerCreatedAgent({ agentInstanceId: "agent-r", createdByAgentInstanceId: "parent-1" });
    await registry.markRecycled("agent-r");

    const reloaded = new AgentCreationRegistry({ stateDirectory });
    const record = await reloaded.getRecord("agent-r");
    expect(record?.recycledAtIso).not.toBeNull();
    const guard = new AgentAddressGuard({ registry: reloaded });
    expect(await guard.isDeliverableRecipient("agent-r")).toBe(false);
    // 历史仍可追溯"谁建的"
    expect(await guard.resolveCreatorOf("agent-r")).toBe("parent-1");
  });
});
