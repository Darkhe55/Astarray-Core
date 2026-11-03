/**
 * GUI-04-02（2026-11-04）：门面层的历史回滚入口。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createApplication(authenticatedUserId?: string) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-recovery-sdk-"));
  directories.push(stateDirectory);
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
  });
}

describe("作用域配置历史回滚（门面）", () => {
  it("列出摘要；恢复为新的 revision；未认证拒绝", async () => {
    const application = await createApplication("user-1");
    try {
      await application.updateScopedPermission({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 1,
        permissionProfileId: "assist",
      });
      await application.updateScopedPermission({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 2,
        permissionProfileId: null,
      });
      const entries = await application.listScopedSettingsRecoveryEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.previousRevision).toBe(2);
      expect(entries[0]).not.toHaveProperty("previous");

      const restored = await application.restoreScopedSettingsRecoveryEntry({
        recordedAtIso: entries[0]!.recordedAtIso,
        expectedRevision: 3,
      });
      expect(restored.revision).toBe(4);
      expect(restored.projects["project-a"]?.permission?.permissionProfileId).toBe(
        "assist",
      );
    } finally {
      await application.shutdown();
    }
  });

  it("未认证用户不能恢复", async () => {
    const application = await createApplication();
    try {
      await expect(
        application.restoreScopedSettingsRecoveryEntry({
          recordedAtIso: "2026-11-04T00:00:00.000Z",
          expectedRevision: 0,
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    } finally {
      await application.shutdown();
    }
  });
});
