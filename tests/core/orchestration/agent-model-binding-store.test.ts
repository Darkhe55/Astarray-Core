/** GUI-03 / 方案 A：Agent 模型绑定层级解析。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentModelBindingStore } from "../../../packages/core/src/orchestration/agent-model-binding-store.js";

const directories: string[] = [];
async function createStore(): Promise<AgentModelBindingStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-bindings-"));
  directories.push(directory);
  return new AgentModelBindingStore({ baseDirectory: directory });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent 模型绑定", () => {
  it("① 未配置时继承当前 Provider 配置", async () => {
    const store = await createStore();
    await expect(
      store.resolve({
        projectIdentifier: "p",
        sessionIdentifier: "s",
        agentInstanceId: "a",
      }),
    ).resolves.toBeNull();
  });

  it("② agent 覆盖优先于 session/project/application", async () => {
    const store = await createStore();
    const doc = await store.read();
    await store.setBinding({
      scope: "project",
      scopeIdentifier: "p",
      providerId: "provider",
      modelIdentifier: "model-project",
      expectedRevision: doc.revision,
      updatedByUserId: "user",
    });
    const afterProject = await store.read();
    await store.setBinding({
      scope: "agent",
      scopeIdentifier: "a",
      providerId: "provider",
      modelIdentifier: "model-agent",
      expectedRevision: afterProject.revision,
      updatedByUserId: "user",
    });
    const resolved = await store.resolve({
      projectIdentifier: "p",
      sessionIdentifier: "s",
      agentInstanceId: "a",
    });
    expect(resolved?.scope).toBe("agent");
    expect(resolved?.binding.modelIdentifier).toBe("model-agent");
    await store.markApplied({
      scope: "agent",
      scopeIdentifier: "a",
      missionId: "mission-1",
    });
    const afterApply = await store.resolve({
      projectIdentifier: "p",
      sessionIdentifier: "s",
      agentInstanceId: "a",
    });
    expect(afterApply?.binding.lastAppliedMissionId).toBe("mission-1");
    expect(afterApply?.binding.appliedAtIso).toBeTruthy();
    await store.markFailed({
      scope: "agent",
      scopeIdentifier: "a",
      reason: "模型配置不存在",
    });
    const afterFailure = await store.resolve({
      projectIdentifier: "p",
      sessionIdentifier: "s",
      agentInstanceId: "a",
    });
    expect(afterFailure?.binding.lastFailureReason).toBe("模型配置不存在");
  });

  it("③ 过期 revision 拒绝", async () => {
    const store = await createStore();
    await store.setBinding({
      scope: "application",
      scopeIdentifier: "application",
      providerId: "provider",
      modelIdentifier: "model",
      expectedRevision: 1,
      updatedByUserId: "user",
    });
    await expect(
      store.setBinding({
        scope: "application",
        scopeIdentifier: "application",
        providerId: "provider",
        modelIdentifier: "next",
        expectedRevision: 1,
        updatedByUserId: "user",
      }),
    ).rejects.toThrow("revision");
  });
});


