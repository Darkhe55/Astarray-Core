/**
 * GUI-03 F01（2026-11-03）：通知偏好的门面入口单测（认证用户约束 + 默认值 + 更新）。
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
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-notify-sdk-"));
  directories.push(stateDirectory);
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
  });
}

describe("通知偏好门面入口", () => {
  it("未认证 ⇒ 拒绝读写", async () => {
    const application = await createApplication();
    try {
      await expect(application.getNotificationPreferences({})).rejects.toThrow();
    } finally {
      await application.shutdown();
    }
  });

  it("默认值 → 更新 → 再读；陈旧 revision 被拒", async () => {
    const application = await createApplication("user-1");
    try {
      const initial = await application.getNotificationPreferences({
        projectIdentifier: "project-a",
      });
      expect(initial.preferences).toEqual({
        complete: true,
        failure: true,
        pending: true,
        system: false,
      });

      const updated = await application.updateNotificationPreferences({
        projectIdentifier: "project-a",
        preferences: { complete: false, failure: true, pending: false, system: true },
      });
      expect(updated.revision).toBe(1);

      const readBack = await application.getNotificationPreferences({
        projectIdentifier: "project-a",
      });
      expect(readBack.preferences.system).toBe(true);

      await expect(
        application.updateNotificationPreferences({
          projectIdentifier: "project-a",
          preferences: { complete: true, failure: true, pending: true, system: false },
          expectedRevision: 0,
        }),
      ).rejects.toThrow();
    } finally {
      await application.shutdown();
    }
  });
});
