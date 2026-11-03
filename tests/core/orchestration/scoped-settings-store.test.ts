/** GUI-03-02：项目/会话作用域配置存储。 */
import { mkdtemp, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
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
        configuredMaximumGlobalContextTokenCount: -2,
        updatedByUserId: "user-a",
      }),
    ).rejects.toThrow("非负整数");
  });
});


describe("GUI-04-02 覆盖前旧版本保全", () => {
  it("第二次写入前保存旧版本历史（首次创建不制造空备份）", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-recovery-"));
    directories.push(directory);
    const store = new ScopedSettingsStore({ baseDirectory: directory });
    await store.updateContext({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 4096,
      updatedByUserId: "user-a",
    });
    await store.updatePermission({
      scope: "session",
      identifier: "session-a",
      expectedRevision: 2,
      permissionProfileId: "profile-x",
      updatedByUserId: "user-a",
    });
    const history = await fs.readFile(
      path.join(directory, "scoped-settings", "recovery", "history.jsonl"),
      "utf8",
    );
    const lines = history.split(/\r?\n/).filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { previous: { revision: number } };
    expect(entry.previous.revision).toBe(2);
  });

  it("旧版本备份失败 ⇒ 拒绝覆盖（revision 不变）", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-fail-"));
    directories.push(directory);
    const store = new ScopedSettingsStore({ baseDirectory: directory });
    await store.updateContext({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 4096,
      updatedByUserId: "user-a",
    });
    // 用一个同名文件占位 recovery 目录 ⇒ mkdir 失败 ⇒ 备份失败。
    await fs.writeFile(
      path.join(directory, "scoped-settings", "recovery"),
      "not-a-directory",
      "utf8",
    );
    await expect(
      store.updateContext({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 2,
        configuredMaximumGlobalContextTokenCount: 8192,
        updatedByUserId: "user-a",
      }),
    ).rejects.toMatchObject({ errorCode: "scoped-settings-backup-failed" });
    const reread = await store.read();
    expect(reread.revision).toBe(2);
    expect(reread.projects["project-a"]?.context?.configuredMaximumGlobalContextTokenCount).toBe(4096);
  });
});

describe("GUI-04-02 恢复继承（删除覆盖字段）", () => {
  it("上下文 -1 与权限 null ⇒ 删除对应字段，而非写 0/null", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-clear-"));
    directories.push(directory);
    const store = new ScopedSettingsStore({ baseDirectory: directory });
    await store.updateContext({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 4096,
      updatedByUserId: "user-a",
    });
    await store.updatePermission({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 2,
      permissionProfileId: "profile-x",
      updatedByUserId: "user-a",
    });

    const clearedPermission = await store.updatePermission({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 3,
      permissionProfileId: null,
      updatedByUserId: "user-a",
    });
    expect(clearedPermission.projects["project-a"]?.permission).toBeUndefined();
    expect(clearedPermission.projects["project-a"]?.context).toBeDefined();

    const clearedContext = await store.updateContext({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 4,
      configuredMaximumGlobalContextTokenCount: -1,
      updatedByUserId: "user-a",
    });
    expect(clearedContext.projects["project-a"]).toBeUndefined();
    expect(clearedContext.revision).toBe(5);
  });

  it("非法负值（-2）被拒", async () => {
    const store = await createStore();
    await expect(
      store.updateContext({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: -2,
        updatedByUserId: "user-a",
      }),
    ).rejects.toThrow(/恢复继承/);
  });
});

describe("GUI-04-04 会话覆盖按稳定会话解析", () => {
  it("会话覆盖优先；缺会话标识时回退项目；missionId 不能顶替", async () => {
    const { resolveScopedContextOverride } = await import(
      "../../../packages/core/src/orchestration/scoped-settings-store.js"
    );
    const document = {
      schemaVersion: 1 as const,
      revision: 3,
      projects: {
        "project-a": {
          context: {
            configuredMaximumGlobalContextTokenCount: 4096,
            updatedAtIso: "t",
            updatedByUserId: "u",
          },
        },
      },
      sessions: {
        "conversation-a": {
          context: {
            configuredMaximumGlobalContextTokenCount: 1024,
            updatedAtIso: "t",
            updatedByUserId: "u",
          },
        },
      },
    };
    expect(
      resolveScopedContextOverride({
        document,
        projectIdentifier: "project-a",
        conversationIdentifier: "conversation-a",
      })?.configuredMaximumGlobalContextTokenCount,
    ).toBe(1024);
    expect(
      resolveScopedContextOverride({
        document,
        projectIdentifier: "project-a",
        conversationIdentifier: null,
      })?.configuredMaximumGlobalContextTokenCount,
    ).toBe(4096);
    expect(
      resolveScopedContextOverride({
        document,
        projectIdentifier: null,
        conversationIdentifier: "mission-123",
      }),
    ).toBeUndefined();
  });
});

describe("GUI-04-02 跨进程写锁", () => {
  it("两个实例并发写同一 revision：只有一个成功", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-lock-"));
    directories.push(directory);
    const first = new ScopedSettingsStore({ baseDirectory: directory });
    const second = new ScopedSettingsStore({ baseDirectory: directory });
    const results = await Promise.allSettled([
      first.updateContext({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: 4096,
        updatedByUserId: "user-a",
      }),
      second.updateContext({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: 8192,
        updatedByUserId: "user-b",
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      errorCode: "stale-revision",
    });
    const reread = await first.read();
    expect(reread.revision).toBe(2);
  });

  it("持锁进程存活且等待超时 ⇒ 拒绝，删除锁文件的行为不发生", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-lock-busy-"));
    directories.push(directory);
    const store = new ScopedSettingsStore({
      baseDirectory: directory,
      lockTimeoutMilliseconds: 100,
      ownerIdentifier: "test-busy",
    });
    const lockPath = path.join(directory, "scoped-settings", "settings.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ token: "other", pid: process.pid, reason: "test" }),
      "utf8",
    );
    await expect(
      store.updateContext({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: 4096,
        updatedByUserId: "user-a",
      }),
    ).rejects.toMatchObject({ errorCode: "scoped-settings-lock-timeout" });
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it("持锁进程已不存在 ⇒ 接管并成功写入；写后释放锁", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-scoped-lock-stale-"));
    directories.push(directory);
    const store = new ScopedSettingsStore({
      baseDirectory: directory,
      ownerIdentifier: "test-stale",
      isProcessAlive: () => false,
    });
    const lockPath = path.join(directory, "scoped-settings", "settings.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ token: "dead", pid: 999_999, reason: "test" }),
      "utf8",
    );
    const updated = await store.updateContext({
      scope: "project",
      identifier: "project-a",
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 4096,
      updatedByUserId: "user-a",
    });
    expect(updated.revision).toBe(2);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });
});

describe("ADR-0205 会话权限覆盖解析", () => {
  it("会话优先；缺会话回退项目；mission 不能顶替会话", async () => {
    const { resolveScopedPermissionOverride } = await import(
      "../../../packages/core/src/orchestration/scoped-settings-store.js"
    );
    const document = {
      schemaVersion: 1 as const,
      revision: 5,
      projects: {
        "project-a": {
          permission: {
            permissionProfileId: "assist",
            updatedAtIso: "t",
            updatedByUserId: "u",
          },
        },
      },
      sessions: {
        "conversation-a": {
          permission: {
            permissionProfileId: "devolve",
            updatedAtIso: "t",
            updatedByUserId: "u",
          },
        },
      },
    };
    expect(
      resolveScopedPermissionOverride({
        document,
        projectIdentifier: "project-a",
        conversationIdentifier: "conversation-a",
      })?.permissionProfileId,
    ).toBe("devolve");
    expect(
      resolveScopedPermissionOverride({
        document,
        projectIdentifier: "project-a",
        conversationIdentifier: null,
      })?.permissionProfileId,
    ).toBe("assist");
    expect(
      resolveScopedPermissionOverride({
        document,
        projectIdentifier: null,
        conversationIdentifier: "mission-1",
      }),
    ).toBeUndefined();
  });
});
