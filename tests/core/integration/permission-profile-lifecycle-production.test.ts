/**
 * B6R-04b（2026-11-06）：权限组生命周期核心控制面。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

async function createRuntime(stateDirectory: string) {
  return createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
}

describe("权限组生命周期控制面", () => {
  it("创建/列表/重置/删除；重名与内置删除拒绝", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-profile-lifecycle-"));
    directories.push(stateDirectory);
    const runtime = await createRuntime(stateDirectory);
    try {
      const created = await runtime.controller.createPermissionProfile({
        displayName: "我的权限组",
        source: { kind: "blank" },
      });
      expect(created.permissionProfileId).toMatch(/^profile-/);
      const listed = await runtime.controller.listPermissionProfiles({ page: 1, pageSize: 50 });
      expect(
        listed.profiles.some(
          (profile) => profile.permissionProfileId === created.permissionProfileId,
        ),
      ).toBe(true);

      await expect(
        runtime.controller.createPermissionProfile({
          displayName: "我的权限组",
          source: { kind: "blank" },
        }),
      ).rejects.toThrow(/名称|重复|唯一/u);

      const reset = await runtime.controller.resetPermissionProfile({
        permissionProfileId: created.permissionProfileId,
        source: { kind: "builtin", profileId: "assist" },
        expectedRevision: created.revision,
      });
      expect(reset.revision).toBeGreaterThan(created.revision);

      await expect(
        runtime.controller.deletePermissionProfile({
          permissionProfileId: "assist",
          isCurrentlyActive: false,
        }),
      ).rejects.toThrow(/不存在|内置/u);

      const deleted = await runtime.controller.deletePermissionProfile({
        permissionProfileId: created.permissionProfileId,
        isCurrentlyActive: false,
      });
      expect(deleted.deleted).toBe(true);
      const afterDelete = await runtime.controller.listPermissionProfiles({ page: 1, pageSize: 50 });
      expect(
        afterDelete.profiles.some(
          (profile) => profile.permissionProfileId === created.permissionProfileId,
        ),
      ).toBe(false);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("当前使用组不可删除；切换持久化（重启后仍为自定义组）", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-profile-switch-"));
    directories.push(stateDirectory);
    const first = await createRuntime(stateDirectory);
    const created = await first.controller.createPermissionProfile({
      displayName: "切换目标组",
      source: { kind: "builtin", profileId: "assist" },
    });
    await first.controller.switchPermissionProfile({
      kind: "custom",
      profileId: created.permissionProfileId,
    });
    await expect(
      first.controller.deletePermissionProfile({
        permissionProfileId: created.permissionProfileId,
        isCurrentlyActive: true,
      }),
    ).rejects.toThrow(/当前|使用/u);
    await first.shutdown();

    const second = await createRuntime(stateDirectory);
    try {
      const current = await second.controller.getCurrentPermissionProfileReference();
      expect(current).toEqual({ kind: "custom", profileId: created.permissionProfileId });
    } finally {
      await second.shutdown().catch(() => undefined);
    }
  });

  it("切换到不存在的自定义组 ⇒ 拒绝（不落悬空引用）", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-profile-missing-"));
    directories.push(stateDirectory);
    const runtime = await createRuntime(stateDirectory);
    try {
      await expect(
        runtime.controller.switchPermissionProfile({
          kind: "custom",
          profileId: "profile-does-not-exist",
        }),
      ).rejects.toThrow();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
