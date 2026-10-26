/** GUI-03-02：项目/会话作用域配置存储。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScopedSettingsStore } from "../../../packages/core/src/orchestration/scoped-settings-store.js";

const directories: string[] = [];
async function createStore(): Promise<ScopedSettingsStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-"));
  directories.push(directory);
  return new ScopedSettingsStore({ baseDirectory: directory });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("项目/会话作用域配置", () => {
  it("① 默认 revision=1 且无覆盖", async () => {
    const store = await createStore();
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      revision: 1,
      projects: {},
      sessions: {},
    });
  });

  it("② 写入项目上下文覆盖并递增 revision", async () => {
    const store = await createStore();
    const updated = await store.updateContext({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 8192,
      updatedByUserId: "user-a",
    });
    expect(updated.revision).toBe(2);
    expect(store.getCached().revision).toBe(2);
    expect(
      updated.projects["project-a"]?.context?.configuredMaximumGlobalContextTokenCount,
    ).toBe(8192);
    const reread = await store.read();
    expect(reread.revision).toBe(2);
  });

  it("③ 过期 revision 拒绝，不写半截", async () => {
    const store = await createStore();
    await store.updatePermission({
      scope: "session",
      identifier: "session-a",
      expectedRevision: 1,
      permissionProfileId: "assist",
      updatedByUserId: "user-a",
    });
    await expect(
      store.updateContext({
        scope: "session",
        identifier: "session-a",
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: 1024,
        updatedByUserId: "user-a",
      }),
    ).rejects.toThrow("revision");
    const reread = await store.read();
    expect(reread.revision).toBe(2);
    expect(reread.sessions["session-a"]?.context).toBeUndefined();
  });

  it("④ 非法预算拒绝", async () => {
    const store = await createStore();
    await expect(
      store.updateContext({
        scope: "project",
        identifier: "p",
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: -1,
        updatedByUserId: "user-a",
      }),
    ).rejects.toThrow("非负整数");
  });
});

